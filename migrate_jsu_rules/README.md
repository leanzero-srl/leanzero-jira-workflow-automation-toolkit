# migrate_jsu_rules_dc_to_cloud

Migrate **Jira Suite Utilities (JSU)** workflow rules from **Jira Data Center** to **Jira Cloud** by converting each JSU rule into either a native Cloud rule (`system:*`) or a JMWE Cloud rule (`connect:*`), and updating the same-named Cloud workflows in place via the bulk workflow update API.

This script is a sibling of [`clone_workflow_rules/`](../clone_workflow_rules/) and reuses its `JiraCloudClient` and `FieldMapper` — do **not** modify the clone_workflow_rules code.

---

## What this script does (and doesn't)

| Does | Doesn't |
|---|---|
| Reads OSWorkflow XML files exported from Jira DC | Read DC workflows over REST (DC's REST doesn't expose rule bodies — see Constraints) |
| Identifies JSU-only rules (by `com.googlecode.jsu.workflow.*` Java class name) | Touch any non-JSU rule (OOTB, JMWE, ScriptRunner, etc. — left intact) |
| Translates DC custom field IDs to Cloud IDs by exact name match | Translate field VALUES (e.g. status names in `valueFieldCondition` are passed through verbatim — usually fine since Cloud uses names too) |
| Updates the same-named Cloud workflow in place | Create new workflows or rename existing ones |
| Removes broken pre-existing rules whose customfield refs don't exist on Cloud (or are un-translated DC IDs) | Touch Connect/Forge rule config blobs (opaque stringified JSON) |
| Runs validation against `/workflows/update/validation` before mutation | Auto-fix Cloud validation errors — they're surfaced for operator review |
| Always-fresh dedup: every apply re-fetches each Cloud workflow live and snapshots its rule fingerprints BEFORE mutation; rows already present are classified as `already-on-cloud` and never appended (see [Dedup freshness contract](#dedup-freshness-contract)) | Roll back changes — re-running with prior state is the only "undo" |
| Builds an operator-facing `manual_review_<TS>.xlsx` summary at the end of every `--apply` / `--validate-only` / `--dry-run` run, with one tab per category needing manual attention | Replace expert review of the Cloud UI for migrated rules — the workbook is a checklist, not a sign-off |
| Fan-out to ALL same-named Cloud transitions when DC common-actions produce duplicates | Resolve transition meaning from non-name attributes (from-status, to-status are not used to disambiguate) |

---

## Important constraints (read before running)

### Jira DC doesn't expose workflow rule bodies via REST

`GET /rest/api/2/workflow` returns only summaries (`name`, `description`, `steps`). The full transition + rule definitions are NOT exposed by any documented REST endpoint, and the admin pages that show them are gated by **WebSudo** (re-enter password) which can't be passed when 2FA is enforced. This script therefore reads workflows from **OSWorkflow XML files exported from the DC admin UI** (see step 1 of the runbook).

### JSU on DC uses Java class names as the rule type identifier

Unlike Cloud-style rules (`com.googlecode.jira-suite-utilities:fields-required-validator`), JSU rules on DC are identified by their `class.name` arg — the full Java class path, e.g. `com.googlecode.jsu.workflow.validator.FieldsRequiredValidator`. The XML parser handles both shapes, but if you encounter a third format, the catalog will need an entry.

### Custom field IDs differ between DC and Cloud

A migrated workflow on Cloud has new numeric `customfield_NNNNN` IDs. Passing DC IDs straight through produces the dreaded "Current field is no longer valid - it might have been deleted" UI message. The applier resolves DC IDs to Cloud IDs by **field name match** at apply time (using `clone_workflow_rules/src/fieldMapper.js`).

---

## Architecture

```
┌─────────────────┐  --collect  ┌──────────────────┐
│ Workflow XML    │ ──────────► │ inventory        │
│ exports         │             │ + conversion     │
│ (from DC admin) │             │   plan           │
└─────────────────┘             └────────┬─────────┘
                                         │ operator review
                                         │ (edit conversion_plan.json)
                                         ▼
┌──────────────┐    --apply     ┌──────────────────┐
│ Cloud target │ ◄──────────── │ patched workflow │
│ (live)       │   /update     │ + validation     │
└──────────────┘                └──────────────────┘
```

Two phases:

1. **`--collect`** — reads DC XMLs, parses to a normalized internal shape, identifies JSU rules, fetches DC field catalog, pre-checks Cloud target. Pure-data; no mutation.
2. **`--apply`** — reads collected data, builds DC→Cloud field-ID map, fetches live Cloud workflow, **prunes broken rules**, **appends converted JSU rules**, validates, mutates.

---

# Fresh-start workflow (NEW source/target instance pair)

⚠️ **Read this first if you're migrating against a different DC and Cloud than your last run** — the script has built-in safety checks to prevent the catastrophic case of yesterday's plan being applied to today's tenant pair.

## Why the safety check matters

Every artifact in a `logs/collected_<TS>/` directory — `field_remapping_resolved.json`, `dc_status_catalog.json`, every `update_payload_<wf>.json` — is computed against one specific (DC, Cloud) pair. Re-running `--apply` against a *different* Cloud target silently corrupts the new tenant: customfield IDs from the old Cloud leak into rules pushed at the new Cloud, dedup snapshots compare against the wrong workflow, validation cache misses surface as nonsensical errors. A 1-minute mistake writes hours of migration to the wrong place.

**The fix**: every collect dir is now stamped with an *instance signature* (DC base URL + Cloud base URL → SHA1 fingerprint), persisted to:
- `INSTANCE.txt` — human-readable banner; first thing you see opening the dir
- `metadata.json` → `instanceSignature: { fingerprint, dcBaseUrl, cloudBaseUrl, xmlDir, capturedAt }`

`--apply` reads this signature, compares to the currently-configured DC + Cloud URLs, and **refuses to run** when they differ. Override only with `--allow-instance-mismatch` if you really mean it.

## Step-by-step for a brand-new instance pair

```bash
# 1. Update credentials for the NEW source + target
$EDITOR .env                  # DC_BASE_URL, DC_USERNAME/PASSWORD,
                              # CLOUD_BASE_URL, CLOUD_API_TOKEN
$EDITOR config.json           # dc.baseUrl, cloud.baseUrl

# 2. Export new XMLs from the NEW DC (admin UI → Workflows → "Text" tab)
mkdir workflows-2026-may/
# … save all .xml exports into workflows-2026-may/ …

# 3. Run --collect with --fresh-start. The flag refuses to write into a
#    non-empty --collect-dir — guards against accidentally mixing into a
#    previous collect's output.
node main/migrate_jsu_rules.js --collect --fresh-start \
  --xml-dir ./workflows-2026-may

# Output ends with:
#   [INFO] Instance signature: fp=<8-hex> dc="https://newdc.example.com" cloud="https://new-tenant.atlassian.net"
#   [INFO] Collect complete. <N> JSU rules across <M> workflow(s).

# 4. Verify the new collect dir
cat logs/collected_<TS>/INSTANCE.txt
# Captured at:   2026-05-08T...
# Fingerprint:   <8-hex>
# DC base URL:   https://newdc.example.com
# Cloud base:    https://new-tenant.atlassian.net
# XML dir:       /abs/path/to/workflows-2026-may

# 5. Validate against the new Cloud (instance check fires automatically)
node main/migrate_jsu_rules.js --apply \
  --collect-dir logs/collected_<TS> \
  --validate-only --force

# Console will log:
#   [INFO] Instance signature OK: collect-dir's (DC, Cloud) URLs match current config (fp=<8-hex>)
# If you accidentally point at the OLD collect dir:
#   [ERROR] INSTANCE MISMATCH: collect-dir was built for a different (DC, Cloud) pair...

# 6. Apply for real
node main/migrate_jsu_rules.js --apply \
  --collect-dir logs/collected_<TS> --force
```

## What `--fresh-start` does (collect time)

When passed at `--collect`:

- **Without `--collect-dir`**: behaves the same as the default — auto-creates a fresh `logs/collected_<TS>/` directory.
- **With `--collect-dir <path>`**: `<path>` must either not exist OR be empty. If it has any content (other than `.DS_Store`), the run is refused with a clear error message. This is the guard against silently overwriting a previous collect's artifacts.

## What the instance check does (apply time)

`--apply` ALWAYS compares the stamped signature against the currently-configured (DC, Cloud) pair. Three outcomes:

| Outcome | Console output | Behaviour |
|---|---|---|
| URLs match | `[INFO] Instance signature OK …` | Run proceeds normally |
| URLs differ | `[ERROR] INSTANCE MISMATCH …` with reason (`cloud-baseurl-mismatch` \| `dc-baseurl-mismatch`) | Hard exit with remediation steps |
| No stamped signature (legacy collect dir) | `[WARN] Collect dir has no instance signature …` | Soft warn, run proceeds — you should re-collect to get a stamped dir for future runs |

URL comparison is normalized: case-insensitive, trailing-slash insensitive. `https://X.atlassian.net/` and `HTTPS://x.atlassian.net` match.

## When you really need to override

Pass `--allow-instance-mismatch`. The applier downgrades the error to a warning that lists the stored vs. current URLs and proceeds. Use only when:

- Your Cloud baseUrl renamed (e.g. `acme.atlassian.net` → `acme-prod.atlassian.net`) but the tenant data is the same
- You're running an audit/dry-run against a Cloud sandbox cloned from the original target
- You're an expert who has confirmed via `field_remapping_resolved.json` that the IDs still apply

```bash
node main/migrate_jsu_rules.js --apply \
  --collect-dir logs/collected_<TS> \
  --allow-instance-mismatch
```

---

# Quickstart for human operators

## Prerequisites

- Node 18+ (tested on 22)
- DC instance: admin-level access + Basic auth credentials
- Cloud instance: API token base64-encoded as `email:token`
- JMWE installed on the Cloud target (assumed; non-JMWE rules will be marked `manual-review` if `--disable-jmwe` is passed)

## Setup

```bash
cd jira/jira-data/migrate_jsu_rules_dc_to_cloud
npm install
cp .env.example .env                  # fill in credentials
cp config.example.json config.json    # tweak workflow selection / overrides
```

`.env`:

```
DC_BASE_URL=https://jira-dc.example.com
DC_USERNAME=your.username
DC_PASSWORD=your-password
CLOUD_BASE_URL=https://your-site.atlassian.net
CLOUD_API_TOKEN=base64-of-email-colon-apitoken
```

`config.json` — set `dc.authType` to `"basic"` (the default in the example). The DC client also supports `"bearer"` if you have a PAT.

## Step 1 — Export workflow XMLs from Jira DC

For each workflow you want to migrate:

1. Log into Jira DC as an admin
2. Navigate to **Administration → Issues → Workflows**
3. Click the workflow name to open it
4. Click the **"Text"** tab (or the "XML" toggle on some DC versions) — the OSWorkflow XML descriptor is displayed
5. **Save the page as XML** (Ctrl/Cmd-S, save as `<Workflow Name>.xml`) into a folder, e.g. `workflows/`

⚠️ **The filename becomes the workflow name.** It must match the corresponding Cloud workflow name **exactly** (including spaces and case). For example: `Product B v1.4.xml` for a workflow named "Product B v1.4".

Drop all XMLs into a single folder (e.g. `workflows/`).

## Step 2 — Run --collect

```bash
# Default — auto-creates a new logs/collected_<TS>/ dir
node main/migrate_jsu_rules.js --collect --xml-dir ./workflows

# When migrating against a NEW (DC, Cloud) instance pair, add --fresh-start
# (see the "Fresh-start workflow" section above)
node main/migrate_jsu_rules.js --collect --fresh-start --xml-dir ./workflows
```

This produces a timestamped output dir under `logs/collected_<TS>/` containing:

| File | Purpose |
|---|---|
| `INSTANCE.txt` | **Human-readable instance stamp** — `(DC, Cloud, XML dir, fingerprint)` banner. Open this first to confirm which tenant pair this collect dir is bound to. |
| `metadata.json` | Run metadata + aggregate stats. Contains `instanceSignature: { fingerprint, dcBaseUrl, cloudBaseUrl, xmlDir, capturedAt }` consumed by apply-time mismatch detection. |
| `dc_workflows/<name>.json` | Raw parsed DC workflow (for audit / re-use) |
| `jsu_rule_inventory.json` | Every JSU rule found, with full path context |
| `conversion_plan.json` | **Human-editable** — review and override strategy per rule |
| `cloud_target_workflows.json` | Pre-check: which workflow names exist on Cloud |
| `dc_field_catalog.json` | Full DC custom-field catalog `{id: name}` |
| `field_mapping.json` | Subset referenced by harvested rules `{dcId: dcName}` |
| `dc_status_catalog.json` | DC status catalog `{id: name}` (used at apply time for status-name resolution) |
| `conversion_plan_example.json` | Reference doc with all four strategies |
| `migrate_<TS>.log` | Line-oriented log mirror |

Successful collect output ends with:

```
[INFO] Instance signature: fp=<8-hex> dc="..." cloud="..."
[INFO] Collect complete. <N> JSU rules across <M> workflow(s).
```

## Step 3 — Review the conversion plan

Open `logs/collected_<TS>/conversion_plan.json`. For each row you can edit only the `strategy` field:

| Strategy | Effect |
|---|---|
| `native` | Convert to a Cloud `system:*` rule |
| `jmwe` | Convert to a JMWE `connect:*` rule |
| `skip` | Drop the rule entirely |
| `manual-review` | Skip + record under `unmapped_rules.json` for human follow-up |

**Strongly recommended**: skim the rows where `confidence` is `"low"` or `"none"`. Those are most likely to need attention.

## Step 4 — Validate against Cloud

```bash
node main/migrate_jsu_rules.js --apply --collect-dir logs/collected_<TS> --validate-only --force
```

This:

- Resolves DC field names to Cloud IDs (e.g. `customfield_14223 ("Active Escalation") → customfield_10224`)
- Fetches the live Cloud workflow
- Patches it in memory: prunes broken refs, appends converted rules
- POSTs to `/rest/api/3/workflows/update/validation` (no mutation)
- Saves response to `validation_<workflow>.json`

**Goal**: zero `level: ERROR` entries. `level: WARNING` is advisory and won't block the apply.

If validation fails, see [Troubleshooting](#troubleshooting) and the [AI debug guide](#debug-guide-for-future-ai-assistants).

## Step 5 — Apply (live mutation)

```bash
node main/migrate_jsu_rules.js --apply --collect-dir logs/collected_<TS> --force
```

Default behavior:

- Re-runs validation as a pre-flight; aborts if errors (overrideable with `--ignore-errors`)
- Calls `POST /rest/api/3/workflows/update`
- Cloud workflow version increments (visible in `apply_<TS>.json`)
- Re-runnable: idempotent on identical input
- **Always-fresh dedup** — see [Dedup freshness contract](#dedup-freshness-contract) below

Successful apply output:

```
[INFO] Instance signature OK: collect-dir's (DC, Cloud) URLs match current config (fp=<8-hex>)
[INFO] Pruned <X> system rule(s) with broken customfield refs ...
[INFO] Cloud has <Y> duplicate-named transition group(s); rules will be applied to all instances
[INFO] Apply report written to logs/.../apply_<TS>.json
[INFO] Already-on-Cloud (dedup-skipped) rules written to logs/.../already_on_cloud.json (<N> rule(s) deduplicated against live Cloud snapshot)
[INFO] Manual-review summary workbook written to logs/.../manual_review_<TS>.xlsx
```

If the collect dir was built for a different (DC, Cloud) pair than the one currently configured, you'll see this hard error instead — see [Fresh-start workflow](#fresh-start-workflow-new-sourcetarget-instance-pair):

```
[ERROR] INSTANCE MISMATCH: collect-dir was built for a different (DC, Cloud) pair...
  reason:  cloud-baseurl-mismatch
  details: Cloud baseUrl mismatch: collect-dir was built for "https://old.atlassian.net" but current config points at "https://new.atlassian.net"
  collect-dir fp: aaaa1111
  current fp:     bbbb2222

Two ways out:
  1. (RECOMMENDED) Run a fresh --collect against the new instance pair:
       node main/migrate_jsu_rules.js --collect --fresh-start --xml-dir <new-xmls>
  2. Override (DANGEROUS, only if you really mean it):
       --apply --collect-dir <dir> --allow-instance-mismatch
```

### Apply artifacts (one collect dir, many apply runs)

Each `--apply` run writes the following into the collect dir:

| File | Purpose |
|---|---|
| `apply_<TS>.json` | Full machine-readable run report (per-workflow status, appended rules, dedup stats) |
| `unmapped_rules.json` | Rows the apply phase couldn't process — manual-review, mapper-failed, unresolved transitions, in-run duplicates |
| `already_on_cloud.json` | Rows the LIVE Cloud snapshot proved were already present — proof that dedup ran |
| `cloud_pre_existing_fingerprints_<workflow>.json` | The fresh Cloud-side fingerprint snapshot taken at apply time, per workflow. Stamped with `liveSnapshotAt`. |
| `field_remapping_resolved.json` | DC→Cloud customfield ID map resolved by name match |
| `status_remapping_resolved.json` | DC→Cloud status ID map resolved by name match |
| `update_payload_<workflow>.json` | The patched workflow payload that was POSTed (or would have been, in dry-run) |
| `validation_<workflow>.json` | Cloud validation response per workflow |
| **`manual_review_<TS>.xlsx`** | **Operator-facing summary workbook — read this first, see [The manual-review workbook](#the-manual-review-workbook)** |
| `migrate_<TS>.log` | Run log mirror |

### The manual-review workbook

`manual_review_<TS>.xlsx` is the one-stop checklist for everything a human operator should look at after a run. It's regenerated at the end of every `--apply`, `--validate-only`, and `--dry-run`. Open it before you do anything else.

Sheets (rendered only when non-empty, except Summary + Run Info):

| # | Sheet | What it surfaces |
|---|---|---|
| 1 | Summary | Counters per category, color-coded green / amber / red |
| 2 | Run Info | Apply timestamps, mode, dedup-contract reminder, per-workflow live-snapshot stamps |
| 3 | Manual Review (Plan) | Plan rows whose strategy was set to `manual-review`. Operator must convert each one in the Cloud UI. |
| 4 | Mapper Failed | Plan rows where the strategy was `native`/`jmwe` but the mapper returned `null` — usually because a referenced DC field has no Cloud equivalent. |
| 5 | Unresolved Cloud Transition | Plan rows whose Cloud transition couldn't be matched. The rule is effectively dropped — fix transition naming or set `workflowNameOverrides` and re-run. |
| 6 | Workflows Missing on Cloud | Workflow names in the plan with no Cloud-side workflow of the same name. |
| 7 | Workflow Apply Status | Per-workflow status (applied / blocked_by_validation / error / skipped_not_on_cloud / dry_run / validated) with appended-rule and dedup counts. Color-coded by status. |
| 8 | Validation Errors | ERROR-level entries from `validation_<wf>.json`. Block apply unless `--force --ignore-errors`. |
| 9 | Validation Warnings | WARNING-level entries (advisory, e.g. `NON_UNIQUE_OUTBOUND_TRANSITION_NAMES_FROM_STATUS`). |
| 10 | Field Catalog Gaps | DC customfields with no Cloud equivalent by name. Any rule referencing such a field will land in 'Mapper Failed'. |
| 11 | Status Catalog Gaps | DC statuses with no Cloud match. Only matters when a JSU rule references the status. |
| 12 | Disabled Connect Rules | Connect (JMWE) rules left disabled in the payload because their Groovy didn't translate to a clean Nunjucks/Jira-Expression. Each one needs a manual edit in the Cloud UI. Includes `problemTypes` (`GroovyScriptToNunjucks` etc.) and `problemLocations`. |
| 13 | Unknown JSU shortNames | JSU rule classes encountered that aren't in `src/jsuRuleCatalog.js`. Each one auto-flags as manual-review. Add a catalog entry + mapper, then re-run. |
| 14 | Already on Cloud (Dedup) | Rules the live snapshot proved were already on Cloud. Informational — proof that dedup ran and re-runs converge. |
| 15 | Duplicate Plan Rows | Rows that produced the same converted rule earlier in the same run (e.g. multiple FieldsRequired DC validators merged into one Cloud rule). Informational. |

The workbook never blocks the run — failure to generate it is logged as a warning only, so the apply still completes.

### Dedup freshness contract

`--apply` is **idempotent against fresh Cloud state**. Re-running the same plan against the same Cloud target will never duplicate rules.

How it works:

1. `_processWorkflow` calls `_fetchCloudWorkflow` for each workflow — every run, no caching, no reuse of the collect-time snapshot.
2. **Immediately after fetch, before any mutation,** the applier captures a fingerprint snapshot of the live Cloud workflow's existing rules per transition. The snapshot is persisted to `cloud_pre_existing_fingerprints_<workflow>.json` with a `liveSnapshotAt` ISO timestamp.
3. For each plan row that produces a converted rule, the strict shared fingerprint (`sharedRuleFingerprint`) is compared against the live snapshot.
   - `fieldRequired` validators are tested per-field (using `collectRuleFps`'s expanded fingerprints) so multi-field merges still fire when DC has more required fields than Cloud.
   - When the fingerprint is in the snapshot, the row is classified as **already-on-cloud** and is never appended.
4. Rows passing the snapshot test go through `_appendIfAbsent`, which is now a second line of defence catching in-run duplicates (e.g. two plan rows producing the same merged Cloud rule). These are recorded as `duplicate-plan-row` in `unmapped_rules.json`.
5. The collect-time `cloud_target_workflows.json` is **never** consulted at apply time for dedup. It's a snapshot of "which Cloud workflows existed at collect" — informational only, marked with `_note` and `checkedAt`.

The `Already on Cloud (Dedup)` sheet in the Excel workbook lists every row classified by step 3, so an operator can confirm dedup behaved sanely.

## Step 6 — Spot-check in Cloud UI

Open the migrated workflow in Cloud (Admin → Workflows → "<name>"). Pick a transition you know had JSU rules and verify:

- Validators show real Cloud field names (no "Current field is no longer valid" red error)
- Conditions/post-functions look semantically equivalent to the DC originals

## Step 7 — Holistic XML ↔ Cloud comparison (cutover gate)

`audit_oneforone.js` confirms every plan row landed somewhere — but it doesn't catch broken expressions, lost conditional gates, duplicate spray, or rules that exist on Cloud but were never in our plan. `compare_xml_to_cloud.js` does. Run it before cutover:

```sh
# Spot-check one workflow (live fetch, ~5s)
node compare_xml_to_cloud.js --collect-dir logs/collected_<ts>/ \
  --workflow "Defect v2 for Build project"

# Full batch (live fetch, ~5–10 min depending on Cloud latency)
node compare_xml_to_cloud.js --collect-dir logs/collected_<ts>/ --all

# Re-run from cached payloads (no Cloud calls; fast iteration after a fix-and-rerun)
node compare_xml_to_cloud.js --collect-dir logs/collected_<ts>/ --all --no-fetch

# Self-tests (sanity-check the predicate table + round-trip determinism)
node compare_xml_to_cloud.js --collect-dir logs/collected_<ts>/ --self-test
```

Output goes to `logs/<collect-dir>/compare_<ts>/` — `compare.json` (machine) and `compare.md` (human, sorted by severity). Categories:

| Category | Severity | Meaning |
|---|---|---|
| `MISSING_TRANSITION_UNRESOLVED` / `MISSING_CATALOG_MISS` / `MISSING_FIELD_UNMAPPED` / `MISSING_STATUS_UNMAPPED` / `MISSING_MAPPER_NULL` / `MISSING_OTHER` | BLOCKER | DC has the rule; Cloud doesn't. Subcategory = root cause. |
| `EXTRA_ON_CLOUD` | BLOCKER | Cloud rule with our `migration-success` tag but no DC counterpart — likely spray residue. |
| `DUPLICATE_ON_CLOUD` | HIGH | Multiple Cloud rules share an identity fingerprint. |
| `EXPRESSION_BROKEN` | BLOCKER | Jira Expression has the `issue.X == "literal"` object-vs-string bug. |
| `NUNJUCKS_BROKEN` | BLOCKER | Nunjucks template still has GString / JSP / unbalanced `{% if %}`. |
| `DISABLED_MISMATCH` | HIGH | Rule disabled on Cloud but enabled in DC. |
| `PRESUMED_NATIVE_JIRA` | INFO | `system:*` rule on Cloud with no migration tag — placed by Atlassian's CMA, not by us. Not a bug; scan to confirm DC also has the source rule. |
| `OK` | INFO | Pair matched, deep-diff clean. |

Exit code is 1 when blockers are present, 0 otherwise — wire into a pre-cutover gate.

---

## CLI reference

```
COLLECT
  --xml-dir <path>          REQUIRED. Folder containing exported OSWorkflow XMLs
  --collect-dir <path>      Output dir (default: logs/collected_<TS>)
  --config <path>           Path to config.json (default: ./config.json)

APPLY
  --collect-dir <path>      REQUIRED. Output dir from --collect
  --validate-only           Never mutate; POST to /workflows/update/validation
  --dry-run                 Build payloads, save to disk, never POST
  --force                   Skip hard-error checks (transitions missing on Cloud)
  --ignore-errors           With --force, lets validation errors through to mutation
  --disable-jmwe            Treat JMWE-strategy rules as manual-review (skip them)
  --workflow-names W1,W2    Apply only a subset of the plan
```

REST-only collect (kept for parity, but Jira DC doesn't expose rule bodies — usually unusable):

```
COLLECT (REST mode — RARELY WORKS)
  --project-keys K1,K2      Resolve workflow names from project schemes
  --workflow-names W1,W2    Explicit names
  --all-workflows           Fetch every workflow
```

---

## Troubleshooting

### Validation: `Invalid value in 'XYZ' parameter.`

The mapper is sending an enum value Cloud doesn't accept. Check the relevant function in `src/jsuNativeMappers.js` or `src/jsuJmweMappers.js`. Common gotchas:

- `system:check-field-value` `fieldValue` must be a JSON-array string (`'["Resolved"]'`), not a plain string
- `system:copy-value-from-other-field` `issueSource` must be `"SAME"` or `"PARENT"` (uppercase)

### Validation: `Missing parameter "X" in rule "<uuid>".`

The mapper isn't emitting a required parameter. Inspect a sample of the existing Cloud workflow (use a scratch script — see AI guide) to see what shape the rule expects.

### `payload.statuses : must not be empty`

Means the applier didn't receive the top-level statuses from the workflow lookup. This is wired in — if you see it, the `_fetchCloudWorkflow` method needs to be re-checked. Likely cause: the response shape changed.

### `Current field is no longer valid - it might have been deleted` (in Cloud UI)

This is the symptom of un-translated DC field IDs leaking through. The current implementation:

1. Resolves DC names to Cloud IDs at apply time (`field_remapping_resolved.json`)
2. Prunes any pre-existing rule with a broken customfield ref before re-applying

If you see this, run `--apply` again — the prune step should remove the offender.

### `DC connection unavailable`

Verify `DC_BASE_URL`, `DC_USERNAME`, `DC_PASSWORD`. Hit the URL in a browser; if it 2FA-prompts, that's why session login fails — but Basic auth on REST should still work because most DC instances allow it for API tokens / direct credentials. The script doesn't do session login, so it shouldn't matter.

### Cloud rejects workflow update with 409

Another admin edited the workflow between fetch and update. The applier auto-retries once. If it fails again, re-run the whole `--apply` — it's idempotent.

---

## Known limitations

- **JSU macros** like `%%CURRENT_USER%%`, `%%CURRENT_DATETIME%%` in `update-issue-field` rules are passed through as **literal strings**. Cloud doesn't interpret them. Operator must replace those rules manually with the right native or Forge equivalents.
- **JMWE (Cloud) rule shapes** are stubs. The Connect rule format on Cloud uses `connect:expression-condition` / `connect:remote-workflow-function` with `appKey` + stringified `config` JSON — radically different from the DC-style `connect:com.innovalog...__<ModuleKey>` we initially designed for. The JMWE mapper file (`jsuJmweMappers.js`) is structured but largely untested against live Cloud.
- **Status / resolution / role IDs in rule values** (e.g. JSU `update-issue-field` setting `resolution = "13"`) are not remapped. Only customfield IDs are translated. If your DC has `resolution=13` as "Won't Fix" but Cloud has `resolution=10000` for the same name, the rule will set the wrong value.
- **Connect/Forge rule configs are NOT touched.** They're stringified JSON blobs we don't try to interpret. If you have legacy JMWE-on-DC rules whose configs reference DC field IDs, they'll continue to be broken on Cloud after this script runs. That's a separate migration concern (see `jira/apps/jmwe/`).

---

## JSU rule catalog (current coverage)

The catalog lives in [`src/jsuRuleCatalog.js`](src/jsuRuleCatalog.js). Unknown JSU classes encountered at collect time auto-flag as `manual-review` so the catalog can be extended in one place.

Verified-working against real workflows:

| JSU class (DC) | Strategy | Cloud target | Confidence |
|---|---|---|---|
| `com.googlecode.jsu.workflow.validator.FieldsRequiredValidator` | native | `system:validate-field-value` (`ruleType: fieldRequired`) | high |
| `com.googlecode.jsu.workflow.condition.ValueFieldCondition` | native | `system:check-field-value` | high |
| `com.googlecode.jsu.workflow.function.ClearFieldValuePostFunction` | native | `system:update-field` (with empty `value`) | high |
| `com.googlecode.jsu.workflow.function.UpdateIssueCustomFieldPostFunction` | native | `system:update-field` | high |
| `com.googlecode.jsu.workflow.function.CopyValueFromOtherFieldPostFunction` | native | `system:copy-value-from-other-field` (with `issueSource: SAME`) | high |
| `com.innovalog.jmwe.plugins.validators.PreviousStatusValidator` | native | `system:previous-status-validator` | high |
| `com.googlecode.jsu.workflow.condition.UserIsInAnyRolesCondition` | jmwe | `connect:expression-condition` (uses `user.getProjectRoles(issue.project)`) | high |
| `com.googlecode.jsu.workflow.condition.UserIsInAnyGroupsCondition` | jmwe | `connect:expression-condition` (uses `user.groups`) | high |
| `com.googlecode.jsu.workflow.condition.UserIsInCustomFieldCondition` | jmwe | `connect:expression-condition` (bracket access on `issue["customfield_NNN"]`) | medium |

Stubbed but unverified (mapper exists; needs live validation):

- `regex-validator`, `date-compare-validator`, `windows-date-validator`, `user-permission-validator`
- `subtasks-blocking-condition`, `previous-status-condition`, `hide-from-user-condition`, `no-operation-condition`
- `assign-to-current-user`, `copy-value-from-previous-status`, `send-custom-email`, `create-issue`, `transition-linked-issue`
- `set-field-value-automatically` (deliberately left as `manual-review`)

### R2 (round-2) issue fixes

The compare/audit pass surfaces "R2" issues — rules where the mapper produces output but the result is silently broken on Cloud. The deep-research pass (May 2026) addressed the highest-impact ones:

| Issue | Symptom | Fix |
|---|---|---|
| `system:check-field-value` only emitted `=` and `!=` | JSU `priority > 5` persisted as `priority = 5` on Cloud | Full 6-comparator (`>`, `>=`, `=`, `<=`, `<`, `!=`) + 5-comparisonType (`STRING`, `NUMBER`, `DATE`, `DATE_WITHOUT_TIME`, `OPTIONID`) translation. STRING/OPTIONID still demote `>`/`<` to `!=`/`=` per Cloud's restriction. Sourced from JSU's `ConditionCheckerFactory` constants. |
| `system:previous-status-validator` rejected as phantom | CMA-migrated PreviousStatusValidator rules silently dropped on every apply | Added to the valid system rule allowlist + native mapper for the `previous-status-validator` shortName |
| `UserIsInAnyRolesCondition` Jira Expression always false | Cloud silently rejected rules using non-existent `user.roles` property | Rewrote to `user.getProjectRoles(issue.project).some(role => [...].includes(role.name))` per Atlassian's User type reference |
| `UserIsInAnyGroupsCondition` not handled at all | Rules silently flagged manual-review | New mapper using `user.groups: List<String>` membership check |
| `UserIsInCustomFieldCondition` dot-access on customfield IDs | Jira Expressions doesn't allow `issue.customfield_10100` | Bracket access: `issue["customfield_NNN"]` |
| `%%CURRENT_USER%%` etc. silently passed through as literals | Rules persisted with `customfield_X = "%%CURRENT_USER%%"` literal text | Now rejected with explicit `JSU runtime macro has no Cloud equivalent` reason; surfaced in dedicated **JSU Macros** Excel sheet |
| Status reference resolution lumped into "field unresolved" | Operator couldn't tell which rules failed for what reason | Distinct reason buckets: macro / status / field / no-mapper, each routed to its own Excel sheet |

The combination of these closes the bulk of the **MISSING_OTHER (90)** entries from `compare_xml_to_cloud.js` reports.

### R3 (review pass) — dedup + conversions audit (May 2026)

A second deep audit and web-research pass extended the catalog and tightened dedup. Highlights:

#### Dedup tightening

| Gap | Symptom | Fix |
|---|---|---|
| `problems[]` arrays were part of canonical fingerprint | A CMA-tagged rule with Groovy translation markers and our translated copy without markers were treated as distinct → 100+ near-duplicate Connect rules survived `_pruneExactDuplicates` | Added `problems` to the ephemeral-key strip list in `stripEphemeralKeys` |
| Status / field lists fingerprinted in given order | `previousStatusIds: "5,6"` and `previousStatusIds: "6,5"` produced different fingerprints — same rule survived as two | Sort CSV / JSON-array IDs canonically in fingerprint computation |
| `system:previous-status-validator` had no fingerprint entry | Fell through to verbatim parameter-hash equality, missed order-only variants | Added explicit fingerprint with sorted `previousStatusIds` |
| `system:parent-or-child-blocking-validator` had no fingerprint entry | Same problem — duplicates survived | Added explicit fingerprint with sorted `statusIds` and `blocker` |
| `system:proforma-forms-submitted` had no fingerprint entry | Multiple identical JSM Proforma validators survived | Added fingerprint |
| `system:update-field` fingerprint omitted `mode` | `mode: "" ` and `mode: "append"` rules with the same field/value were treated as duplicates of each other | `mode` now part of the fingerprint |
| `_prunePhantomSystemRules` allowlist missed 14 documented rules | Pruned legitimate Cloud-side rules — `system:trigger-webhook`, `system:hide-from-user-condition`, `system:permission-condition`, `system:set-issue-security`, `system:assign-to-current-user`, etc. | Added all 14 to the allowlist |

#### Mapper enrichment

| Rule | Old strategy | New strategy | Notes |
|---|---|---|---|
| `jmwe-parent-status-validator` | `jmwe` ScriptedValidator (Jira Expression) | **native** `system:parent-or-child-blocking-validator` (`blocker: PARENT`) | Cloud has a built-in rule for this — verified against live Cloud workflow sample. JMWE config persists status NAMES; new `remapStatusByName` helper resolves them through DC catalog → Cloud IDs by name. |
| `update-issue-field` (with `append.value=true`) | always `mode: ""` | `mode: "append"` when JSU `append.value` truthy | Preserves multi-value-field append semantics |

#### Catalog notes upgraded with verified parameter shapes

- `system:check-field-value` — full comparator/comparisonType matrix documented
- `system:previous-status-validator` — `previousStatusIds`, `mostRecentStatusOnly` (sourced from Atlassian REST docs)
- `system:parent-or-child-blocking-validator` — `blocker: PARENT|CHILD`, `statusIds` (sourced from go-atlassian.io reference)
- `system:restrict-issue-transition` — full 7-parameter shape (`accountIds`, `roleIds`, `groupIds`, `permissionKeys`, `groupCustomFields`, `allowUserCustomFields`, `denyUserCustomFields`)

---
---

# Debug guide for future AI assistants

> This section captures the hard-won facts from the original implementation against a real Jira DC + Cloud pair. **Read this before you change anything in `src/`** — there are several non-obvious traps that already cost iteration cycles.

## Module map

```
main/migrate_jsu_rules.js     CLI parsing, config loading, phase dispatch
src/
├── jiraDcClient.js           DC REST (Basic/Bearer auth). /rest/api/2/* endpoints.
├── jsuRuleCatalog.js         Single source of truth: JSU rule type → strategy.
│                             Has BOTH the Cloud-style "com.googlecode.jira-suite-utilities:" prefix
│                             AND the DC-style "com.googlecode.jsu.workflow." Java class prefix.
├── jsuNativeMappers.js       JSU configuration → Cloud system:* rule (parameters map).
├── jsuJmweMappers.js         JSU configuration → JMWE connect:* rule (mostly untested).
├── jsuInventory.js           Walks parsed DC workflows, harvests JSU-only rules.
├── jsuCollector.js           Phase 1 orchestration. Builds field_mapping.json from DC catalog.
├── jsuApplier.js             Phase 2 orchestration. Field remapping + live fingerprint snapshot + prune + append + validate. Verifies instance signature on construction.
├── ruleFingerprint.js        Shared rule-identity fingerprints (system:*/connect:*) used by applier + audit + compare.
├── instanceSignature.js      (DC, Cloud) signature stamping + apply-time mismatch detection. Backs the --fresh-start safety net.
├── transitionMatcher.js      Name-based DC↔Cloud transition alignment (handles duplicates).
├── dcWorkflowXmlParser.js    OSWorkflow XML → normalized {transitions: [{rules: {...}}]}.
├── manualReviewExcelWriter.js Builds the manual-review XLSX summary at the end of each --apply run.
└── utils.js                  uuidv4, timestampSlug, env: resolver, hashParams, Logger.
```

External dependencies (do NOT modify):

- `../../clone_workflow_rules/src/jiraCloudClient.js` — Cloud REST. Imported as-is.
- `../../clone_workflow_rules/src/fieldMapper.js` — DC name → Cloud ID resolver. Imported as-is.

## Key data structures

### Normalized parsed workflow (after `dcWorkflowXmlParser.js`)

```js
{
  name: "Product B v1.4",
  transitions: [
    {
      id: 221,
      name: "Edit",
      from: ["10005"],   // Jira status IDs (from `<meta name="jira.status.id">`)
      to: "10006",
      type: "DIRECTED",  // INITIAL | GLOBAL | DIRECTED
      rules: {
        conditionsTree: {
          nodeType: "compound",
          operator: "AND",
          conditions: [
            { nodeType: "simple", type: "...", configuration: {...} },
            { nodeType: "compound", operator: "OR", conditions: [...] }
          ]
        },
        validators: [{ type: "...", configuration: {...} }],
        postFunctions: [{ type: "...", configuration: {...} }]
      }
    }
  ]
}
```

### Conversion plan row

```js
{
  workflowName, transitionName,
  ruleCategory: "condition" | "validator" | "postFunction",
  pathWithinTransition: "(AND)[0](OR)[1]",  // for nested conditions
  dcType: "com.googlecode.jsu.workflow.validator.FieldsRequiredValidator",
  shortName: "fields-required-validator",
  defaultStrategy, strategy,                 // strategy is the editable override
  confidence, nativeRuleKey, jmweModuleKey, notes,
  internalId,                                 // UUID for traceability
  configuration: { ...DC arg map... }
}
```

### Field remapping

- `dc_field_catalog.json`: `{ "customfield_14223": "Active Escalation", ... }` — full DC catalog (~hundreds of entries)
- `field_mapping.json`: `{ "customfield_14223": "Active Escalation", ... }` — subset referenced by harvested rules
- `field_remapping_resolved.json`: `{ "customfield_14223": "customfield_10224", ... }` — built at apply time

## How a rule flows from DC XML to Cloud

```
DC XML <validator type="class">                     dcWorkflowXmlParser.js
  <arg name="hidFieldsList">cf_X@@cf_Y@@</arg>      → { type: "com.googlecode.jsu.workflow.validator.
  <arg name="class.name">com.googlecode.jsu...</arg>      FieldsRequiredValidator",
                                                        configuration: { hidFieldsList: "cf_X@@cf_Y@@",
                                                                         "class.name": "..." } }
                                                          ↓
                                                      jsuRuleCatalog.isJsuRule(type) → true
                                                      jsuRuleCatalog.getJsuShortName(type) → "fields-required-validator"
                                                          ↓
                                                      jsuInventory.buildInventory → conversion_plan.row
                                                          ↓ (--apply)
                                                      jsuNativeMappers.fieldsRequiredValidator(cfg, ctx):
                                                        - remapFieldList("cf_X@@cf_Y@@", ctx)
                                                          - splits on "@@"
                                                          - remapField("cf_X") → ctx.fieldRemapping["cf_X"] → cloud_X
                                                        - emits { ruleKey: "system:validate-field-value",
                                                                  parameters: { ruleType: "fieldRequired",
                                                                                fieldsRequired: "cloud_X,cloud_Y", ... } }
                                                          ↓
                                                      jsuApplier._appendIfAbsent — idempotency check
                                                      jsuApplier._pruneInvalidFieldRefs — drop broken
                                                      jsuApplier._buildUpdateEnvelope
                                                          ↓
                                                      POST /rest/api/3/workflows/update
```

## Hard-won facts (don't re-learn these)

### 1. DC vs Cloud rule-type identification

DC OSWorkflow XML has TWO ways a rule can identify itself:

- `<arg name="full.module.key">` — for plugin-registered modules (Slack, JMWE post-functions). DC concatenates app key + module key WITHOUT a separator: `"com.atlassian.jira.plugin.system.workflowupdate-issue-field-function"`.
- `<arg name="class.name">` — the Java class. JSU rules use ONLY this (no `full.module.key`).

The XML parser tries `full.module.key` first, falls back to `class.name`. Both are persisted in the configuration map (under `class.name` key) so downstream mappers can disambiguate if needed.

### 2. Cloud system:* ruleKeys — verified vs traps

✅ **Correct (verified live)**:
- `system:validate-field-value` — with `ruleType: "fieldRequired" | "fieldChanged" | "fieldMatches"`
- `system:check-field-value`
- `system:check-permission-validator`
- `system:update-field` (post-function — handles both update and clear)
- `system:copy-value-from-other-field`
- `system:change-assignee`
- `system:restrict-issue-transition`

❌ **WRONG (do NOT use)**:
- `system:update-issue-field` — does not exist; correct is `system:update-field`
- `system:clear-field-value-post-function` — does not exist; emulate via `system:update-field` with empty `value`
- `system:assign-to-current-user` — does not exist; correct is `system:change-assignee` with `type: "to-current-user"`

To list all valid ruleKeys against a target workflow:

```js
const r = await cloud.makeRequest("GET", `/rest/api/3/workflows/capabilities?workflowId=${wfId}`);
console.log(r.systemRules.map(x => x.ruleKey));
```

### 3. Cloud parameter shapes — surprising specifics

| ruleKey | Param | Shape gotcha |
|---|---|---|
| `system:validate-field-value` (fieldRequired) | `fieldsRequired` | comma-separated string, NOT `fieldIds` |
| `system:check-field-value` | `fieldValue` | JSON-array string: `'["Resolved"]'`, NOT plain string |
| `system:check-field-value` | `comparator` | only `"="` or `"!="` accepted (JSU has 10+ codes) |
| `system:update-field` | `field`, `value`, `mode` | NOT `fieldId`, `fieldValue` |
| `system:copy-value-from-other-field` | `issueSource` | enum: `"SAME"` or `"PARENT"` (uppercase). `"current"`, `"CURRENT"`, `"current_issue"` all rejected |
| `system:change-assignee` | `type` | enum: `"to-current-user"`, `"to-selected-user"` (with `accountId`) |
| All system rules | param values | **all string** — booleans/numbers must be stringified (`"false"`, not `false`) |

When in doubt, sample the live Cloud workflow:

```js
const r = await cloud.makeRequest("POST", "/rest/api/3/workflows", { workflowNames: ["<name>"] });
// Look at r.workflows[0].transitions[i].validators / .actions / .conditions for params shape
```

### 4. Connect (JMWE/ScriptRunner) rule shape — different from system

Connect rules use a single generic `ruleKey` with the actual identity in `parameters.appKey`:

```js
{
  ruleKey: "connect:expression-validator",          // or "connect:expression-condition",
                                                     //    "connect:remote-workflow-function"
  parameters: {
    appKey: "com.innovalog.jmwe.jira-misc-workflow-extensions__CurrentStatusCondition",
    config: "{...stringified JSON config...}",
    id: "<uuid>", disabled: "false", tag: ""
  }
}
```

The original design assumed `connect:com.innovalog.jmwe.jira-misc-workflow-extensions__<Module>` was the ruleKey. **It isn't.** The `jsuJmweMappers.js` module emits the wrong shape and has not been validated against live Cloud. If you need JMWE-strategy rules, fix this first.

### 5. Field ID translation — three-step process

DC and Cloud have independent customfield ID spaces. Even if a numeric ID exists on both, it usually points to different fields. Translation is by **name match**:

1. **Collect time**: `_writeFieldMapping` fetches DC's `/rest/api/2/field`, persists `{dcId: dcName}` for every customfield referenced in harvested rules.
2. **Apply time**: `_buildFieldRemapping` uses `FieldMapper` (from clone_workflow_rules) to search Cloud `/rest/api/3/field/search` for each DC name, producing `{dcId: cloudId}`.
3. **Mapper time**: `remapField(dcId, ctx)` looks up the Cloud ID. System fields (`summary`, `status`, `assignee`, `resolution`, etc.) pass through unchanged. Customfields not in the catalog at all are passed through with a warning. Customfields in the catalog mapped to `null` (FieldMapper couldn't find a match) cause the mapper to return `null` → applier marks the rule as unmapped.

`FieldMapper.searchExactField` enforces exact name match (the search API returns fuzzy matches). `(migrated)` suffix is tried first as a courtesy.

### 6. Idempotency

`hashParams(parameters)`:
- Sorts keys
- Excludes `id`, `tag`, `disabled` (those are server-assigned / advisory)
- SHA1, first 16 chars

`_appendIfAbsent` checks if any existing rule on the same transition has the same `ruleKey + paramsHash`. If yes, skip. Re-runs are safe.

### 7. Duplicate-name transitions on Cloud

DC's `<common-action id="X"/>` references materialize as N same-named Cloud transitions, one per source step. For "Product B v1.4" we observed 12× "Edit", 12× "Review", 9× "SLAs Reset", 4× "Reopen", 4× "Fail", etc.

The applier appends each converted rule to **all** same-named transitions (`patchedByName.get(name)` returns an array). The transition matcher's `ambiguous` list is informational — the applier handles them; it doesn't bail.

### 8. Validation: ERROR vs WARNING

`/workflows/update/validation` returns:

```json
{ "errors": [
    { "level": "ERROR",   "code": "INVALID_RULE_PARAMETER", ... },
    { "level": "WARNING", "code": "NON_UNIQUE_OUTBOUND_TRANSITION_NAMES_FROM_STATUS", ... }
] }
```

`_validationHasErrors` filters to `level === "ERROR"`. Warnings are advisory and don't block apply. The most common warning (non-unique outbound transitions from "Any status" to a target) is a side effect of duplicate-name transitions and is unrelated to JSU rule additions.

### 9. Pruning broken refs (`_pruneInvalidFieldRefs`)

The cleanup pass removes any `system:*` rule whose customfield params contain refs that are EITHER:

- (a) not in the live Cloud customfield catalog, OR
- (b) in the DC catalog AND mapped to a different Cloud ID (i.e. an un-translated DC ID that incidentally collides with a different Cloud field)

Connect/Forge rule configs are intentionally untouched (opaque JSON blobs).

If you ever need to disable this (e.g. for an audit-only run), it's not currently a flag; you'd need to short-circuit `_pruneInvalidFieldRefs` to return 0.

### 10. Auth & connection caveats

| | Auth | Notes |
|---|---|---|
| DC REST (`/rest/api/2/*`) | Basic (username + password) OR Bearer (PAT) | Works fine for fields, projects, schemes |
| DC admin pages (`/secure/admin/*`) | Cookie session + WebSudo | **Blocked by 2FA** for username+password sessions on this instance. Don't try to scrape these. |
| DC `/rest/auth/1/session` | username + password | Returns 403 when 2FA is enforced |
| DC `/rest/workflowDesigner/1.0/workflows?name=X` | Basic | Returns layout + rule counts, NOT rule bodies. Useful for transition counts only. |
| DC `/rest/api/2/workflow?workflowName=X` | Basic | Returns SUMMARY only — name, description, steps, isDefault. **Does NOT include rules.** |
| Cloud REST | Basic (`base64(email:apitoken)`) | All `/rest/api/3/*` endpoints work |

The XML-export route around DC's REST/admin gap is not a workaround — it's the supported path.

## Common iteration: adding a new JSU rule type

When `--collect` reports `unknownShortNames: ["foo-bar-validator"]`:

1. Add catalog entry in `src/jsuRuleCatalog.js`:
   - Add the Java class to `JSU_DC_CLASS_TO_SHORTNAME`
   - Add an entry in `CATALOG` with `ruleCategory`, `defaultStrategy`, `nativeRuleKey` (best guess), `confidence: "low"`, `notes`
2. Add a mapper function in `src/jsuNativeMappers.js` (or `jsuJmweMappers.js`):
   - Read DC config arg names (inspect a sample `dc_workflows/<name>.json` for shape)
   - Call `remapField` for any customfield references
   - Return `null` if a required field can't be resolved
   - Emit `{ ruleKey, parameters: stringifyParams({...}) }`
3. Register the function in the `NATIVE_MAPPERS` (or `JMWE_MAPPERS`) map at the bottom of the file, keyed by shortName
4. Re-run `--collect` then `--apply --validate-only --force`
5. Iterate based on Cloud's validation response

## Common iteration: fixing a Cloud validation error

The `/workflows/update/validation` response gives structured errors:

```json
{ "type": "RULE", "code": "INVALID_RULE_PARAMETER",
  "message": "Invalid value in 'X' parameter.",
  "elementReference": { "ruleId": "<uuid>" } }
```

Workflow:

1. Find the offending rule by `ruleId` in `update_payload_<workflow>.json` (only rules with explicit `parameters.id` will match; system rules don't always set this)
2. Identify which mapper produced it (by ruleKey + params)
3. Inspect what shape Cloud actually wants:
   - `GET /rest/api/3/workflows/capabilities?workflowId=<id>` for ruleKey existence
   - `POST /rest/api/3/workflows {workflowNames: [<name>]}` for live samples of working rules
   - Brute-force probe enum values (write a scratch script that submits to `/validation` with each candidate)
4. Fix the mapper, re-run `--validate-only --force`, repeat

When probing enum values, use a workflow that's safe to corrupt-and-revert (validation-only doesn't mutate, so no real risk).

## Files to inspect when debugging

In order of usefulness:

1. **`logs/collected_<TS>/migrate_<TS>.log`** — line-oriented log mirror of console output
2. **`logs/collected_<TS>/validation_<workflow>.json`** — Cloud's structured validation response (most useful)
3. **`logs/collected_<TS>/update_payload_<workflow>.json`** — exact body sent to `/workflows/update[/validation]`
4. **`logs/collected_<TS>/apply_<TS>.json`** — per-workflow execution report (status, appended count, mutationResponse)
5. **`logs/collected_<TS>/unmapped_rules.json`** — every rule that didn't apply, with reason (`idempotent-skip`, `manual-review`, `field unresolved`, etc.)
6. **`logs/collected_<TS>/dc_workflows/<name>.json`** — normalized DC workflow (post-XML-parse)
7. **`logs/collected_<TS>/conversion_plan.json`** — JSU rules + chosen strategy
8. **`logs/collected_<TS>/field_remapping_resolved.json`** — DC ID → Cloud ID map
9. **`logs/collected_<TS>/cloud_target_workflows.json`** — Cloud workflow IDs/versions (for multi-workflow runs)

## Risky operations that need a human gate

- **`--apply` without `--validate-only`** — first time on any new workflow, ALWAYS `--validate-only` first
- **Running on a production Cloud workflow** — confirm version bump in apply report; if version didn't change, mutation didn't actually take effect
- **Re-running after a botched apply** — the prune pass cleans up self-inflicted damage, but verify by inspecting `dc_field_catalog.json` and `field_remapping_resolved.json` first
- **Editing the JSU catalog or mappers** — re-validate against the same workflow you tested with; small changes can cause large delta in `appended` vs `idempotent-skip` counts

## Sentinel: when to NOT trust the catalog

If `jsu_rule_inventory.json` shows a JSU class you don't recognize OR a configuration with arg names that look unfamiliar (especially anything with `groovy` or `script` in the name), STOP. JSU has features (Set Field Value Automatically, Send Custom Email with templates) that have no clean Cloud equivalent. Tag those rows as `manual-review` in `conversion_plan.json` and let a human decide.
