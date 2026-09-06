// Stand-alone "permissions-only" pass.
//
// Walks every Cloud filter and ensures org-admins (or the configured group)
// is present in BOTH `editPermissions` and `sharePermissions`. Unlike the
// JQL rewriter, this pass does NOT modify the JQL — and it touches even
// filters that the JQL pipeline left as `no_change` / `skipped` / `failed`.
//
// Per-filter flow (only fires if a change is needed):
//   1. pre-fetch  → current owner + share/edit permissions
//   2. owner-swap → only if needed and missing-org-admins requires a write
//   3. PUT /filter/{id} with editPermissions merged (PUT works for edit)
//   4. POST /filter/{id}/permission with org-admins (PUT silently drops share)
//   5. owner-restore
//
// Idempotent: filters that already have org-admins in BOTH lists are marked
// `no_change` and skipped. Resumable via PlanManager.

const { swapOwner, restoreOwner } = require("./ownerSwap");
const {
  mergeEditPermissions,
  stripForWrite,
  sanitizePermissionsForWrite,
  isGroupMatch,
} = require("./permissions");

class PermissionsOnlyProcessor {
  constructor({ cloudClient, planManager, options = {}, log }) {
    this.cloudClient = cloudClient;
    this.planManager = planManager;
    this.log = log || console.log;
    this.dryRun = options.dryRun || false;
    this.concurrency = options.concurrency || 5;
    this.limit = options.limit || 0;
    this.idFile = options.idFile || null;
    this.currentAccountId = options.currentAccountId || null;
    this.orgAdminsGroup = options.orgAdminsGroup || null;
    this.retryFailed = options.retryFailed || false;
    this.skipNotOwned = options.skipNotOwned || false;
    this.avoidOverwrite = options.avoidOverwrite || false;

    this.stats = {
      totalCloudFilters: 0,
      alreadyHasBoth: 0,
      needsEdit: 0,
      needsShare: 0,
      needsBoth: 0,
      filtersUpdated: 0,
      filtersFailed: 0,
      filtersSkipped: 0,
      ownerSwapFailures: 0,
      ownerRestoreFailures: 0,
      sharePostsAttempted: 0,
      sharePostsSucceeded: 0,
      sharePostsFailed: 0,
      editPutsAttempted: 0,
      editPutsSucceeded: 0,
      editPutsFailed: 0,
    };
  }

  getStats() {
    return { ...this.stats };
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1 — BUILD
  // ─────────────────────────────────────────────────

  async buildPlan(runId) {
    if (!this.orgAdminsGroup) {
      throw new Error(
        "PermissionsOnlyProcessor requires an orgAdminsGroup. Resolve it first via permissions.resolveOrgAdminsGroup.",
      );
    }

    this.log("\nStep 1: Fetching all Cloud filters (with permissions)...");
    let filters = await this.cloudClient.searchAllFilters({
      expand: "owner,sharePermissions,editPermissions",
      limit: this.limit,
    });
    this.log(`  Fetched ${filters.length} filter(s)`);

    if (this.idFile) {
      const fs = require("fs");
      const allowed = new Set(
        fs.readFileSync(this.idFile, "utf8")
          .split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      );
      const before = filters.length;
      filters = filters.filter((f) => allowed.has(String(f.id)));
      this.log(`  --id-file: ${filters.length}/${before} filter(s) match`);
    }
    if (this.skipNotOwned && this.currentAccountId) {
      const before = filters.length;
      filters = filters.filter(
        (f) => f.owner && f.owner.accountId === this.currentAccountId,
      );
      this.log(`  --skip-not-owned: ${filters.length}/${before} owned by current account`);
    }

    this.stats.totalCloudFilters = filters.length;
    this.log("\nStep 2: Classifying filters by what they need...");

    const filtersMap = {};
    const grp = this.orgAdminsGroup;
    for (const f of filters) {
      const cloudId = String(f.id);
      const share = Array.isArray(f.sharePermissions) ? f.sharePermissions : [];
      const edit = Array.isArray(f.editPermissions) ? f.editPermissions : [];
      const hasShareOA = share.some((p) => isGroupMatch(p, grp));
      const hasEditOA = edit.some((p) => isGroupMatch(p, grp));

      let status;
      if (hasShareOA && hasEditOA) {
        status = "no_change";
        this.stats.alreadyHasBoth++;
      } else {
        status = "pending";
        if (!hasShareOA && !hasEditOA) this.stats.needsBoth++;
        else if (!hasShareOA) this.stats.needsShare++;
        else this.stats.needsEdit++;
      }

      filtersMap[cloudId] = {
        status,
        name: f.name || "",
        owner: f.owner
          ? { accountId: f.owner.accountId, displayName: f.owner.displayName }
          : null,
        originalOwner: f.owner
          ? { accountId: f.owner.accountId, displayName: f.owner.displayName }
          : null,
        originalSharePermissions: share,
        originalEditPermissions: edit,
        hasShareOrgAdmins: hasShareOA,
        hasEditOrgAdmins: hasEditOA,
        ownerSwapped: false,
        ownerRestored: false,
        editPut: false,
        sharePosted: false,
        executionPhase: "idle",
        lastStepError: null,
        currentOwnerAccountId: f.owner ? f.owner.accountId : null,
        // expectedLiveJql used only if --avoid-overwrite is enabled
        originalJql: f.jql || "",
        expectedLiveJql: f.jql || "",
        error: null,
        updatedAt: null,
      };
    }

    this.planManager.createMasterIndex(runId);
    const { planFile } = this.planManager.createPlan(runId, filtersMap);
    if (this.planManager.masterIndex) {
      Object.assign(this.planManager.masterIndex.stats, {
        totalCloudFilters: this.stats.totalCloudFilters,
        alreadyHasBoth: this.stats.alreadyHasBoth,
        needsEdit: this.stats.needsEdit,
        needsShare: this.stats.needsShare,
        needsBoth: this.stats.needsBoth,
      });
      this.planManager.saveMasterIndex();
    }

    this.log(`\n  Plan saved: ${planFile}`);
    this.log(
      `  total: ${this.stats.totalCloudFilters}  ` +
        `already-OK: ${this.stats.alreadyHasBoth}  ` +
        `needs-edit-only: ${this.stats.needsEdit}  ` +
        `needs-share-only: ${this.stats.needsShare}  ` +
        `needs-both: ${this.stats.needsBoth}`,
    );
  }

  // ─────────────────────────────────────────────────
  //  PHASE 2 — EXECUTE
  // ─────────────────────────────────────────────────

  async executePlan() {
    const toProcess = this.planManager.getFiltersToProcess(this.retryFailed);
    if (toProcess.length === 0) {
      this.log("  No filters to process.");
      return;
    }
    this.log(
      `\n  Executing permissions plan: ${toProcess.length} filter(s) (concurrency: ${this.concurrency})...`,
    );

    if (this.dryRun) {
      this.log("  *** DRY RUN — No changes will be made ***");
      for (const [cloudId, data] of toProcess) {
        const needs = [];
        if (!data.hasEditOrgAdmins) needs.push("edit");
        if (!data.hasShareOrgAdmins) needs.push("share");
        this.log(
          `    [DRY] filter ${cloudId} "${(data.name || "").slice(0, 40)}": needs ${needs.join("+")}`,
        );
        this.stats.filtersUpdated++;
      }
      return;
    }

    const batchSize = this.concurrency * 5;
    const totalBatches = Math.ceil(toProcess.length / batchSize);
    let processed = 0;
    for (let b = 0; b < totalBatches; b++) {
      const batchStart = b * batchSize;
      const batch = toProcess.slice(batchStart, batchStart + batchSize);
      const results = await this._executeBatch(batch, this.concurrency);

      let rateLimits = 0;
      for (const [cloudId, r] of results) {
        processed++;
        if (r.success) {
          this.planManager.updateFilterStatus(cloudId, "completed");
          this.stats.filtersUpdated++;
        } else if (r.skipped) {
          this.planManager.updateFilterStatus(cloudId, "skipped", r.error);
          this.stats.filtersSkipped++;
        } else {
          this.planManager.updateFilterStatus(cloudId, "failed", r.error);
          this.stats.filtersFailed++;
          if (r.isRateLimit) rateLimits++;
          if (this.stats.filtersFailed <= 10 || this.stats.filtersFailed % 50 === 0) {
            this.log(`    FAILED ${cloudId}: ${r.error}`);
          }
        }
        if (processed % 25 === 0) {
          this.log(
            `    Progress: ${processed}/${toProcess.length} (${this.stats.filtersUpdated} updated, ${this.stats.filtersFailed} failed, ${this.stats.filtersSkipped} skipped)`,
          );
        }
      }
      if (rateLimits > 0) {
        const pauseSeconds = Math.min(10 + rateLimits * 5, 60);
        this.log(`    ${rateLimits} rate limit(s) — pausing ${pauseSeconds}s`);
        await new Promise((r) => setTimeout(r, pauseSeconds * 1000));
      }
      if ((b + 1) % 5 === 0) this.planManager.savePlan();
    }
    this.planManager.savePlan();
    this.log(`\n  Permissions sweep complete: ${this.stats.filtersUpdated} updated, ${this.stats.filtersFailed} failed, ${this.stats.filtersSkipped} skipped.`);
  }

  async _executeBatch(batch, concurrency) {
    const results = new Map();
    let idx = 0;
    const worker = async () => {
      while (idx < batch.length) {
        const entryIdx = idx++;
        const [cloudId, data] = batch[entryIdx];
        const r = await this._executeOne(cloudId, data);
        results.set(cloudId, r);
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, batch.length); i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  async _executeOne(cloudId, data) {
    const pm = this.planManager;
    const grp = this.orgAdminsGroup;

    // Optional re-GET for --avoid-overwrite (live JQL must match what plan
    // captured — protects against external edits between build and execute).
    if (this.avoidOverwrite) {
      try {
        const live = await this.cloudClient.getFilter(cloudId);
        const liveJql = String(live.jql || "").trim();
        const expected = String(data.expectedLiveJql || "").trim();
        if (expected && liveJql !== expected) {
          pm.updateFilterEntry(cloudId, {
            executionPhase: "done",
            lastStepError: "externally_modified",
            liveJqlAtCheck: liveJql,
          });
          return { success: false, skipped: true, error: "externally_modified" };
        }
        // Refresh share/edit from live too — they may have moved.
        data.originalSharePermissions = Array.isArray(live.sharePermissions)
          ? live.sharePermissions
          : [];
        data.originalEditPermissions = Array.isArray(live.editPermissions)
          ? live.editPermissions
          : [];
        data.hasShareOrgAdmins = data.originalSharePermissions.some(
          (p) => isGroupMatch(p, grp),
        );
        data.hasEditOrgAdmins = data.originalEditPermissions.some(
          (p) => isGroupMatch(p, grp),
        );
        if (data.hasShareOrgAdmins && data.hasEditOrgAdmins) {
          pm.updateFilterEntry(cloudId, { executionPhase: "done" });
          return { success: true };
        }
      } catch (err) {
        return {
          success: false,
          error: `pre-GET failed: ${err.message}`,
          isRateLimit: err.statusCode === 429,
        };
      }
    }

    const originalOwnerId =
      data.originalOwner && data.originalOwner.accountId
        ? data.originalOwner.accountId
        : null;
    const needSwap =
      !!this.currentAccountId &&
      !!originalOwnerId &&
      originalOwnerId !== this.currentAccountId;

    // Step 2 — owner swap
    if (needSwap && !data.ownerSwapped) {
      pm.updateFilterEntry(cloudId, { executionPhase: "owner_swapping" });
      try {
        await swapOwner(this.cloudClient, cloudId, this.currentAccountId);
        data.ownerSwapped = true;
        pm.updateFilterEntry(cloudId, {
          ownerSwapped: true,
          currentOwnerAccountId: this.currentAccountId,
          executionPhase: "owner_swapped",
        });
      } catch (err) {
        this.stats.ownerSwapFailures++;
        return {
          success: false,
          error: `owner_swap_failed: ${err.message}`,
          isRateLimit: err.statusCode === 429,
        };
      }
    }

    // Step 3 — PUT to add org-admins to editPermissions if missing
    let putResult = { success: true };
    if (!data.hasEditOrgAdmins && !data.editPut) {
      const ss = sanitizePermissionsForWrite(data.originalEditPermissions || []);
      const merged = mergeEditPermissions(ss.sanitized, grp);
      this.stats.editPutsAttempted++;
      try {
        await this.cloudClient.updateFilter(cloudId, {
          name: data.name,
          // Don't touch jql or description — pass the originals we captured.
          jql: data.originalJql || undefined,
          editPermissions: stripForWrite(merged),
        });
        data.editPut = true;
        this.stats.editPutsSucceeded++;
        pm.updateFilterEntry(cloudId, { editPut: true, executionPhase: "updated" });
      } catch (err) {
        this.stats.editPutsFailed++;
        putResult = { success: false, error: `edit_put_failed: ${err.message}`, isRateLimit: err.statusCode === 429 };
      }
    }

    // Step 4 — POST share permission if missing (and PUT didn't fail)
    let postResult = { success: true };
    if (putResult.success && !data.hasShareOrgAdmins && !data.sharePosted) {
      const body = grp.groupId
        ? { type: "group", groupId: grp.groupId }
        : { type: "group", groupname: grp.name };
      this.stats.sharePostsAttempted++;
      try {
        await this.cloudClient.addFilterSharePermission(cloudId, body);
        data.sharePosted = true;
        this.stats.sharePostsSucceeded++;
        pm.updateFilterEntry(cloudId, { sharePosted: true });
      } catch (err) {
        this.stats.sharePostsFailed++;
        postResult = { success: false, error: `share_post_failed: ${err.message}`, isRateLimit: err.statusCode === 429 };
      }
    }

    // Step 5 — owner restore (always if we swapped)
    if (data.ownerSwapped && !data.ownerRestored && originalOwnerId) {
      pm.updateFilterEntry(cloudId, { executionPhase: "owner_restoring" });
      try {
        await restoreOwner(this.cloudClient, cloudId, originalOwnerId);
        data.ownerRestored = true;
        pm.updateFilterEntry(cloudId, {
          ownerRestored: true,
          currentOwnerAccountId: originalOwnerId,
          executionPhase: "done",
        });
      } catch (err) {
        this.stats.ownerRestoreFailures++;
        return {
          success: false,
          error: `owner_restore_failed: ${err.message}`,
          isRateLimit: err.statusCode === 429,
        };
      }
    } else {
      pm.updateFilterEntry(cloudId, { executionPhase: "done" });
    }

    if (!putResult.success) return putResult;
    if (!postResult.success) return postResult;
    return { success: true };
  }
}

module.exports = PermissionsOnlyProcessor;
