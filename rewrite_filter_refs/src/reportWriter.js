const fs = require("fs");
const path = require("path");

function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values) {
  return values.map(csvEscape).join(",");
}

class ReportWriter {
  constructor(outDir, runId, log) {
    this.outDir = outDir;
    this.runId = runId;
    this.log = log || console.log;
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  }

  /**
   * `filtersMap` is the plan's `filters` object: cloudId -> { name, refs: [...] }.
   * Writes rows only for refs whose resolution is anything other than "ok".
   */
  writeUnresolved(filtersMap) {
    const file = path.join(this.outDir, `unresolved_refs_${this.runId}.csv`);
    const rows = [
      csvRow([
        "kind",
        "cloudFilterId",
        "cloudFilterName",
        "dcId",
        "reason",
        "details",
      ]),
    ];

    for (const [cloudId, entry] of Object.entries(filtersMap)) {
      for (const ref of entry.refs || []) {
        if (ref.resolution === "ok") continue;
        const details =
          ref.resolution === "collision"
            ? `candidates=${(ref.candidates || []).join("|")}`
            : ref.dcName
              ? `dcName=${ref.dcName}`
              : "";
        rows.push(
          csvRow([
            ref.kind || "filter",
            cloudId,
            entry.name,
            ref.dcId,
            ref.resolution,
            details,
          ])
        );
      }
      for (const u of entry.aqlUnresolved || []) {
        // u is either "key:CMDB-99999" or "objectId:123" — split on the first
        // colon so identifiers that happen to contain `:` stay intact.
        const s = String(u);
        const idx = s.indexOf(":");
        const kind = idx === -1 ? "" : s.slice(0, idx);
        const value = idx === -1 ? s : s.slice(idx + 1);
        rows.push(
          csvRow([
            `asset:${kind || "?"}`,
            cloudId,
            entry.name,
            value || s,
            "asset_not_mapped",
            "no DC→Cloud mapping in preloaded asset map",
          ])
        );
      }
    }

    fs.writeFileSync(file, rows.join("\n") + "\n");
    this.log(`  Unresolved refs report: ${file} (${rows.length - 1} rows)`);
    return file;
  }

  writeCollisions(filtersMap) {
    const file = path.join(this.outDir, `collisions_${this.runId}.csv`);
    const rows = [
      csvRow([
        "kind",
        "cloudFilterId",
        "cloudFilterName",
        "dcId",
        "dcName",
        "candidateCloudIds",
      ]),
    ];

    for (const [cloudId, entry] of Object.entries(filtersMap)) {
      for (const ref of entry.refs || []) {
        if (ref.resolution !== "collision") continue;
        rows.push(
          csvRow([
            ref.kind || "filter",
            cloudId,
            entry.name,
            ref.dcId,
            ref.dcName || "",
            (ref.candidates || []).join("|"),
          ])
        );
      }
    }

    fs.writeFileSync(file, rows.join("\n") + "\n");
    this.log(`  Collisions report: ${file} (${rows.length - 1} rows)`);
    return file;
  }

  /**
   * Filters where the owner was swapped to the migration user but the restore
   * step failed. Ops should follow up manually or rerun with --resume.
   */
  writeOrphanedOwnerSwaps(filtersMap) {
    const file = path.join(
      this.outDir,
      `orphaned_owner_swaps_${this.runId}.csv`,
    );
    const rows = [
      csvRow([
        "cloudFilterId",
        "cloudFilterName",
        "originalOwnerAccountId",
        "originalOwnerDisplayName",
        "currentOwnerAccountId",
        "executionPhase",
        "lastStepError",
      ]),
    ];
    let count = 0;
    for (const [cloudId, entry] of Object.entries(filtersMap)) {
      if (!(entry.ownerSwapped && !entry.ownerRestored)) continue;
      rows.push(
        csvRow([
          cloudId,
          entry.name,
          entry.originalOwner ? entry.originalOwner.accountId || "" : "",
          entry.originalOwner ? entry.originalOwner.displayName || "" : "",
          entry.currentOwnerAccountId || "",
          entry.executionPhase || "",
          entry.lastStepError || "",
        ]),
      );
      count++;
    }
    fs.writeFileSync(file, rows.join("\n") + "\n");
    if (count > 0) {
      this.log(
        `  ⚠  Orphaned owner swaps report: ${file} (${count} filters still owned by migration user)`,
      );
    }
    return file;
  }

  writeAssetCollisions(collisions) {
    const file = path.join(this.outDir, `asset_collisions_${this.runId}.csv`);
    const rows = [csvRow(["dcKey", "candidateCloudKeys"])];
    for (const c of collisions || []) {
      rows.push(csvRow([c.dcKey, (c.candidateCloudKeys || []).join("|")]));
    }
    fs.writeFileSync(file, rows.join("\n") + "\n");
    if ((collisions || []).length > 0) {
      this.log(
        `  Asset collision report: ${file} (${collisions.length} rows)`,
      );
    }
    return file;
  }

  // CSV listing every function call removed by --strip-broken-functions.
  writeStrippedFunctions(filtersMap) {
    const file = path.join(this.outDir, `stripped_functions_${this.runId}.csv`);
    const rows = [
      csvRow([
        "cloudFilterId",
        "cloudFilterName",
        "function",
        "removedFragment",
        "originalJql",
        "rewrittenJql",
      ]),
    ];
    let count = 0;
    for (const [cloudId, entry] of Object.entries(filtersMap)) {
      for (const s of entry.strippedFunctions || []) {
        rows.push(
          csvRow([
            cloudId,
            entry.name,
            s.function,
            s.removed,
            entry.originalJql || "",
            entry.rewrittenJql || "",
          ]),
        );
        count++;
      }
    }
    fs.writeFileSync(file, rows.join("\n") + "\n");
    if (count > 0) {
      this.log(`  Stripped functions report: ${file} (${count} rows)`);
    }
    return file;
  }

  // CSV listing filters whose JQL referenced a project key/name not present
  // on the target Cloud tenant.
  writeMissingProjects(filtersMap) {
    const file = path.join(this.outDir, `missing_projects_${this.runId}.csv`);
    const rows = [
      csvRow([
        "cloudFilterId",
        "cloudFilterName",
        "status",
        "missingValues",
        "strippedFromInList",
        "originalJql",
      ]),
    ];
    let count = 0;
    for (const [cloudId, entry] of Object.entries(filtersMap)) {
      const missing = entry.missingProjects || [];
      const stripped = entry.projectStripped || [];
      if (missing.length === 0 && stripped.length === 0) continue;
      rows.push(
        csvRow([
          cloudId,
          entry.name,
          entry.status,
          missing.join("|"),
          stripped.join("|"),
          entry.originalJql || "",
        ]),
      );
      count++;
    }
    fs.writeFileSync(file, rows.join("\n") + "\n");
    if (count > 0) {
      this.log(`  Missing projects report: ${file} (${count} rows)`);
    }
    return file;
  }

  // CSV listing direct Asset-field references that the assetFieldRewriter
  // rewrote to use object names (or left unresolved). One row per rewrite.
  writeAssetFieldRewrites(filtersMap) {
    const file = path.join(
      this.outDir,
      `asset_field_rewrites_${this.runId}.csv`,
    );
    const rows = [
      csvRow([
        "cloudFilterId",
        "cloudFilterName",
        "field",
        "dcValue",
        "cloudName",
        "form",
        "status",
      ]),
    ];
    let count = 0;
    for (const [cloudId, entry] of Object.entries(filtersMap)) {
      for (const r of entry.assetFieldReplacements || []) {
        rows.push(
          csvRow([
            cloudId,
            entry.name,
            r.field || "",
            r.dcValue || "",
            r.cloudName || "",
            r.form || "",
            "ok",
          ]),
        );
        count++;
      }
      for (const u of entry.assetFieldUnresolved || []) {
        const s = String(u);
        const idx = s.indexOf(":");
        const field = idx === -1 ? "" : s.slice(0, idx);
        const value = idx === -1 ? s : s.slice(idx + 1);
        rows.push(
          csvRow([cloudId, entry.name, field, value, "", "", "unresolved"]),
        );
        count++;
      }
    }
    fs.writeFileSync(file, rows.join("\n") + "\n");
    if (count > 0) {
      this.log(`  Asset-field rewrites report: ${file} (${count} rows)`);
    }
    return file;
  }

  // CSV listing Forge traffic-light fields where the rewriter appended
  // `.Label` to value comparisons.
  writeTrafficLightLabels(filtersMap) {
    const file = path.join(
      this.outDir,
      `traffic_light_label_appends_${this.runId}.csv`,
    );
    const rows = [
      csvRow([
        "cloudFilterId",
        "cloudFilterName",
        "field",
        "originalReference",
        "rewrittenReference",
        "originalJql",
        "rewrittenJql",
      ]),
    ];
    let count = 0;
    for (const [cloudId, entry] of Object.entries(filtersMap)) {
      for (const r of entry.trafficLightChanges || []) {
        rows.push(
          csvRow([
            cloudId,
            entry.name,
            r.field || "",
            r.original || "",
            r.rewritten || "",
            entry.originalJql || "",
            entry.rewrittenJql || "",
          ]),
        );
        count++;
      }
    }
    fs.writeFileSync(file, rows.join("\n") + "\n");
    if (count > 0) {
      this.log(`  Traffic-light .Label appends report: ${file} (${count} rows)`);
    }
    return file;
  }

  // CSV listing priority value rewrites — one row per (filter, replacement)
  // where the priority value was rewritten from a DC-era name to the current
  // Cloud name. Driven by entry.priorityReplacements, populated in Pass 2d
  // of buildPlan.
  writePriorityRewrites(filtersMap) {
    const file = path.join(
      this.outDir,
      `priority_rewrites_${this.runId}.csv`,
    );
    const rows = [
      csvRow([
        "cloudFilterId",
        "cloudFilterName",
        "form",
        "from",
        "to",
        "originalJql",
        "rewrittenJql",
      ]),
    ];
    let count = 0;
    for (const [cloudId, entry] of Object.entries(filtersMap)) {
      for (const r of entry.priorityReplacements || []) {
        rows.push(
          csvRow([
            cloudId,
            entry.name,
            r.form || "",
            r.from || "",
            r.to || "",
            entry.originalJql || "",
            entry.rewrittenJql || "",
          ]),
        );
        count++;
      }
    }
    fs.writeFileSync(file, rows.join("\n") + "\n");
    if (count > 0) {
      this.log(`  Priority rewrites report: ${file} (${count} rows)`);
    }
    return file;
  }

  // CSV listing ORDER BY entries on Assets fields that were stripped.
  writeOrderByStripped(filtersMap) {
    const file = path.join(this.outDir, `order_by_stripped_${this.runId}.csv`);
    const rows = [
      csvRow([
        "cloudFilterId",
        "cloudFilterName",
        "field",
        "direction",
        "originalJql",
        "rewrittenJql",
      ]),
    ];
    let count = 0;
    for (const [cloudId, entry] of Object.entries(filtersMap)) {
      for (const s of entry.orderByStripped || []) {
        rows.push(
          csvRow([
            cloudId,
            entry.name,
            s.field || "",
            s.direction || "",
            entry.originalJql || "",
            entry.rewrittenJql || "",
          ]),
        );
        count++;
      }
    }
    fs.writeFileSync(file, rows.join("\n") + "\n");
    if (count > 0) {
      this.log(`  ORDER BY stripped report: ${file} (${count} rows)`);
    }
    return file;
  }

  // CSV listing share/edit permission entries dropped by sanitizePermissionsForWrite
  // or denied-group retry. Useful to track what we lost in the cleanup.
  writeDroppedPermissions(filtersMap) {
    const file = path.join(this.outDir, `dropped_permissions_${this.runId}.csv`);
    const rows = [
      csvRow([
        "cloudFilterId",
        "cloudFilterName",
        "list",
        "reason",
        "type",
        "identifier",
      ]),
    ];
    let count = 0;
    const summarize = (e) => {
      if (!e) return "";
      if (e.user) return `accountId=${e.user.accountId || ""}`;
      if (e.group) return `group=${e.group.name || e.group.groupId || ""}`;
      if (e.project) return `project=${e.project.id || ""}`;
      return "";
    };
    for (const [cloudId, entry] of Object.entries(filtersMap)) {
      for (const d of entry.sharePermissionsDropped || []) {
        rows.push(
          csvRow([cloudId, entry.name, "share", d.reason, d.entry?.type || "", summarize(d.entry)]),
        );
        count++;
      }
      for (const d of entry.editPermissionsDropped || []) {
        rows.push(
          csvRow([cloudId, entry.name, "edit", d.reason, d.entry?.type || "", summarize(d.entry)]),
        );
        count++;
      }
      for (const g of entry.shareGroupsRemovedOnRetry || []) {
        rows.push(
          csvRow([cloudId, entry.name, "share+edit", "denied_group_retry", "group", g]),
        );
        count++;
      }
    }
    fs.writeFileSync(file, rows.join("\n") + "\n");
    if (count > 0) {
      this.log(`  Dropped permissions report: ${file} (${count} rows)`);
    }
    return file;
  }

  writeRewrites(filtersMap) {
    const file = path.join(this.outDir, `rewrites_${this.runId}.csv`);
    const rows = [
      csvRow([
        "cloudFilterId",
        "cloudFilterName",
        "status",
        "originalJql",
        "rewrittenJql",
        "error",
      ]),
    ];

    for (const [cloudId, entry] of Object.entries(filtersMap)) {
      if (entry.status === "no_change") continue;
      rows.push(
        csvRow([
          cloudId,
          entry.name,
          entry.status,
          entry.originalJql || "",
          entry.rewrittenJql || "",
          entry.error || "",
        ])
      );
    }

    fs.writeFileSync(file, rows.join("\n") + "\n");
    this.log(`  Rewrites report: ${file} (${rows.length - 1} rows)`);
    return file;
  }
}

module.exports = ReportWriter;
