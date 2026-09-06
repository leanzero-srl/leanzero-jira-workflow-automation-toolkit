# Clone Workflow Rules — Jira Cloud Migration & JMWE Fixer

A Node.js tool to collect, transform, and apply Jira Cloud workflow definitions between instances (or in place on the same instance). Handles JMWE (Jira Misc Workflow Extensions) cleanup, ScriptRunner rule scaffolding for SMS deployment, and cross-instance entity-ID remapping (statuses, issue types, screens, events, roles, groups, priorities, resolutions, link types, security levels, custom fields).

**Primary use cases (in order of maturity):**

1. **JMWE / configuration fixes in place** — you have workflows on a Cloud instance that need JMWE Connect-prefix normalisation, `remoteWorkflowPostFunctionUUID` cleanup, and custom field remapping after a DC→Cloud migration. Use `--apply --update`.
2. **Clone workflows to another Cloud instance** — used originally to replicate workflow configs across orgs. Creates `_v2` copies so you can cut over via workflow-scheme reassignment. Use `--apply` (default).
3. **ScriptRunner rule handover to SMS** — emits an `extensions.yaml` + Groovy stubs compatible with Adaptavist's ScriptRunner Dev & Deployment Tool. Use `--collect --export-scriptrunner-scaffold`.

---

## Cloud-to-Cloud Literal Copy (`--cloud-to-cloud`) — recommended for cloud→cloud

The original `--collect` reads the **legacy** `GET /rest/api/3/workflow/search` (old rule-`type`
format) and must convert old→new at apply time via `SYSTEM_RULE_KEY_MAP` — the biggest unknown in
this tool (~13 of 18 rule types unverified). For **cloud→cloud** that conversion is unnecessary.

`--cloud-to-cloud` (alias `--cc`) reads workflows via the **new-format** endpoint
`POST /rest/api/3/workflows` (`getWorkflowsEnvelopeByNames`), which already returns every transition
with `conditions` / `validators` / `actions` in `{ ruleKey, parameters }` form — the exact shape the
write endpoints consume. Rules are copied **verbatim** (`ruleKey` unchanged); only IDs are translated
at apply time. This removes the rule-key guessing entirely.

```bash
# Collect (source instance in .env). Writes ONE cohesive bundle file.
node main/clone_workflow_rules.js --cc --collect --all-workflows --collect-dir logs/cc_<name>
```

**Output — a single self-contained bundle** `cc_bundle_<ts>.json`:

| Key | Purpose |
|---|---|
| `workflows[]` | Every workflow **verbatim** in new-format (`version`, `id`, `statuses`, `transitions` with conditions/validators/actions). The source of truth for apply. |
| `fieldCatalog` | `{ customfield_NNN: "source display name" }` — every custom field referenced anywhere (incl. inside JMWE `config` strings and nunjucks). |
| `statusCatalog` | Read-envelope statuses indexed `byReference` / `byId` / `byName`. |
| `entityCatalog` | Source `id → {name,…}` per bucket (statuses, screens, roles, issueTypes, …) for IDs found *inside* rules — reuses the tuned `EMBEDDED_KEY_HINTS` scanner via a new→old shape adapter. |
| `stats` | Counts: workflows, transitions, conditions/validators/actions, ScriptRunner rules (skipped at apply), custom fields (+ unresolved). |

ScriptRunner rules are **counted but not specially handled** — the apply pass skips them entirely
(per requirement). Custom fields that don't resolve on source (deleted / uninstalled-app fields) are
listed under `stats.customFieldsUnresolved` and pass through unchanged at apply (they cannot be
translated).

**Apply — update-in-place (built):**

```bash
# Validate first (no mutation). Token reused for both sites if the same Atlassian account
# administers them; otherwise set TARGET_CLOUD_API_TOKEN.
node main/clone_workflow_rules.js --apply --cc \
  --collect-dir logs/cc_<name> \
  --target-url https://TARGET.atlassian.net \
  --validate-only

# A subset first is wise: add --workflow-names "A,B,C"
# Real run (mutates the target): drop --validate-only.  --dry-run saves payloads only.
```

For each source workflow that exists on the target, the applier re-fetches the live target workflow
(`getWorkflowsEnvelopeByNames`), matches transitions by name, and **replaces their
conditions/validators/actions** with the field-translated source rules. The target keeps its own
status structure and `version` — only rules change. Per rule:

- copied **verbatim** (`ruleKey` and all `id`s preserved — connect/JMWE rules *require* `parameters.id`;
  stripping it makes the validation endpoint 500);
- custom field IDs translated everywhere (deep string walk of `parameters`, the stringified `config`
  JSON, and nunjucks `issue.fields.customfield_NNN`), by exact name (no `(migrated)` suffix);
- structural entity IDs (statuses/screens/roles/…) translated by name; **unresolved IDs pass through
  unchanged** (never dropped — dropping empties params like `groupIds` and yields "blocks transition
  for everyone"). Group IDs are org-level in Atlassian Cloud and usually identical across sibling sites.

Skipped automatically: ScriptRunner rules, workflows not present on the target, system workflows
(`isEditable:false`). The `/workflows/update/validation` endpoint is always called first; ERROR-level
entries block the mutation (WARNING is advisory; `--force` overrides). Per-workflow payloads
(`cc_update_payload_*.json`), validation responses (`cc_validation_*.json`), and a run report
(`cc_apply_<ts>.json`) are written to the collect dir.

Verified end-to-end against `your-sandbox.atlassian.net` (validate-only): 41/43 editable workflows
clean, 2 non-editable system workflows skipped, 9 not on target; 65/77 fields required ID translation
and all translated correctly (0 untranslated source IDs in payloads), 0 ScriptRunner leaked.

---

## Status — Handover Snapshot (2026-04-23)

This section is the critical context for whoever picks this up next.

### What has been verified end-to-end

- **`--collect` works against a real instance.** Ran against 1 project (7 workflows) and against the full `your-sandbox.atlassian.net` instance (220 workflows, 116 JMWE-bearing). Output files populate correctly.
- **Static transformations** (JMWE prefix cleanup, `remoteWorkflowPostFunctionUUID` stripping, customfield_NNNNN regex remap, system post-function stripping, compound condition tree preservation) are unit-tested with real-shape fixtures against the collected data.
- **`id_mapping.json` is populated correctly** for statuses (327 IDs), screens (199), project roles (14), groups (11 names), issue types (6), link types (2), security levels (1). Events bucket resolves most system events but 90%+ of custom events remain unresolved (see "Known Gaps").
- **Hint table tuned against 220 real workflows** — 18 unique rule types and ~40 JMWE value-key shapes audited. Missing keys (`projectRoles` plural, `previousStatus`, `parentStatuses`, `issuetype` lowercase, `selectedIssueTypeId`, `selectedLinkTypeId`, `issueSecurityLevel`, `groups` string-array) were added.
- **`--update` mode wired** (never run against a target yet, see below).
- **`--validate-only` mode wired** (never run against a target yet).

### What has NOT been run against a real target

- **No `--apply` call has been made against any instance.** All payload building is unit-tested but POST shapes are unverified.
- **No `--validate-only` roundtrip has been done.** This is the fastest way to flush out the remaining unknowns — the Atlassian validation endpoint returns structured errors that pinpoint wrong `ruleKey` values and bad parameter shapes.
- **No `--update` call executed.** The update endpoint needs optimistic-locking (`version`) semantics — haven't seen 409 handling in practice.

### What is most likely to need fixing after the first real run

1. **`SYSTEM_RULE_KEY_MAP`** in `src/workflowTransformer.js`. Atlassian publishes no public mapping table for old→new rule keys. Only two are verified from their docs examples (`PermissionValidator` → `system:check-permission-validator`, `ValueFieldCondition` → `system:check-field-value`). The rest are best-guess `system:<TypeName>` fall-throughs. Expect `--validate-only` to return errors for most OOTB types; use those to extend the map.
2. **Parameter shape mapping** for rules where the old config shape doesn't match the new API's flat string-map expectation. `FieldRequiredValidator` and `FieldChangedValidator` have explicit `paramsMapper` functions; add more as `--validate-only` surfaces the need.
3. **Forge ARI rule handling.** Only one Forge rule was seen (1 occurrence of `ari:cloud:ecosystem::extension/...`). The converter emits `forge:<ari>` as the ruleKey — this is unverified.
4. **Custom event name resolution.** 126 of 140 events referenced by workflows could not be resolved on source (the `/rest/api/3/events` endpoint doesn't expose custom events; `FireIssueEventFunction.event.name` is null for custom events). Operator must provide overrides via `id_overrides.json` or re-create events on target first.

### Files you should read first

In this order:

1. `main/clone_workflow_rules.js` — CLI entry point, 200 lines
2. `src/workflowCollector.js` — `--collect` orchestration
3. `src/workflowApplier.js` — `--apply` orchestration (create + update branches)
4. `src/workflowTransformer.js` — pure transformations; the heart of the logic
5. `src/referenceScanner.js` — extracts referenced entity IDs by key hint
6. `src/idMapper.js` — resolves source IDs to target IDs by name

---

## Installation

```bash
cd clone_workflow_rules
npm install
cp .env.example .env
# Edit .env with your CLOUD_BASE_URL and CLOUD_API_TOKEN (base64 of email:apiToken)
```

### `.env` format

```
CLOUD_BASE_URL=https://yourorg.atlassian.net
CLOUD_API_TOKEN=<base64 of "email@domain.com:atlassian_api_token">
```

Generate the token value:

```bash
echo -n "your.email@example.com:YOUR_ATLASSIAN_API_TOKEN" | base64
```

**The same `.env` serves both modes**:

- During `--collect`, `CLOUD_BASE_URL` is the **source**.
- During `--apply`, `CLOUD_BASE_URL` is the **target**.

Swap the URL/token between runs. If source and target are the same instance (common for in-place fixes), no swap needed.

### Security notice

**`.env.example` previously contained a real-looking base64 token string. That token is committed in git history and should be treated as compromised.** Before using this repo in a shared setting:

1. Rotate the exposed Atlassian API token at id.atlassian.com → Security → API tokens.
2. Confirm `.env.example` contains only placeholder values (the current version does).
3. Confirm `.env` is in `.gitignore`.

---

## The Two-Phase Flow

```
┌─────────────────────────┐        ┌─────────────────────────┐
│   SOURCE INSTANCE       │        │   TARGET INSTANCE       │
│   (set in .env)         │        │   (set in .env later)   │
└───────────┬─────────────┘        └───────────▲─────────────┘
            │                                   │
            │ --collect                         │ --apply [--update|--validate-only]
            │                                   │
            ▼                                   │
      ┌───────────────────────────────────────────────────┐
      │   logs/collected_<timestamp>/                     │
      │     workflows/*.json        — raw workflow bodies │
      │     metadata.json           — run summary         │
      │     field_mapping.json      — customfield names   │
      │     id_mapping.json         — all referenced IDs  │
      │                               + their source names│
      │     id_overrides.json.example  — curation seed    │
      │     workflow_schemes.json   — scheme bindings     │
      │     statuses.json           — source catalog      │
      │     scriptrunner-scaffold/  — SMS deploy files    │
      │                               (optional)          │
      └───────────────────────────────────────────────────┘
            ▲                                   │
            │                                   │
            │ (operator edits id_overrides.json │
            │  if auto-resolution misses things)│
            │                                   │
            └───────────────────────────────────┘
```

The output directory is **self-contained**. Everything needed to reproduce `--apply` is in there, including audit trails written on each run (`id_remapping_<ts>.json`, `apply_<ts>.json`, `bulk_payload_*.json`, `update_payload_*.json`, `validation_*.json`).

---

## CLI Reference

### Global

| Flag | Description |
|---|---|
| `--collect` | Phase 1. Read workflows from the instance in `.env`. |
| `--apply` | Phase 2. Write workflows to the instance in `.env`. |
| `--help`, `-h` | Show CLI help |

### `--collect` options

| Flag | Description |
|---|---|
| `--project-keys KEY1,KEY2` | Resolve schemes for these projects and collect referenced workflows |
| `--workflow-names NAME1,NAME2` | Collect specific workflow names directly (exact match) |
| `--all-workflows` | Paginate `/rest/api/3/workflow/search` to collect **every** workflow on the instance |
| `--collect-dir PATH` | Output directory. Default: `logs/collected_<timestamp>` |
| `--export-scriptrunner-scaffold` | Emit `scriptrunner-scaffold/` directory with SMS `extensions.yaml` + Groovy stubs for every ScriptRunner rule found |

At least one of `--project-keys`, `--workflow-names`, or `--all-workflows` is required.

### `--apply` options

| Flag | Description |
|---|---|
| `--collect-dir PATH` | Required. Directory produced by `--collect`. |
| `--update` | **Update existing workflows in place** via `POST /rest/api/3/workflows/update`. Default `--name-suffix` becomes `""`. Workflows missing on target are skipped (never auto-created). Mutually exclusive with `--use-legacy-api`. |
| `--name-suffix STR` | Suffix for new workflow names. Default `_v2` for create, `""` for `--update`. Only matters in create mode. |
| `--assign-schemes` | After creating `_v2` workflows, update workflow schemes to point at them. Ignored in `--update` mode. |
| `--publish` | Publish scheme drafts after `--assign-schemes`. |
| `--dry-run` | Transform and save payloads to `<collect-dir>/dry_run/` or `bulk_payload_*.json`. **No API calls.** |
| `--validate-only` | POST each payload to `/workflows/{create|update}/validation`. Writes `validation_<name>.json` per workflow with the target's exact error response. **No mutations.** |
| `--use-legacy-api` | Force `POST /rest/api/3/workflow/` (the create-only legacy endpoint, retired 2026-02-01 — will likely fail). Emits a warning. |
| `--source-url URL` | Override the source instance URL used for URL-in-config replacement. Default: the URL recorded in `metadata.json`. |

---

## Recommended Runbook — JMWE / Config Fix In Place

This is the workflow the tool is best at right now. Assume one Cloud instance where existing workflows need JMWE fixes and custom-field remaps.

```bash
cd clone_workflow_rules

# .env already points at the instance
# (no need to swap, since source == target)

# 1. Collect EVERY workflow. ~9s per 7 workflows; ~3-5 min for 220.
node main/clone_workflow_rules.js --collect --all-workflows

# 2. Inspect id_mapping.json and id_overrides.json.example
ls -la logs/collected_<ts>/
cat logs/collected_<ts>/id_mapping.json | less

# 3. If any entities have name=null (unresolved), copy the example to overrides and fill IDs:
cp logs/collected_<ts>/id_overrides.json.example logs/collected_<ts>/id_overrides.json
# edit id_overrides.json to provide target IDs (or null to drop)

# 4. Dry-run: no API calls, generates update_payload_*.json files in the collect dir.
node main/clone_workflow_rules.js --apply \
  --collect-dir logs/collected_<ts> \
  --update --dry-run

# 5. Validate-only: POSTs each payload to /workflows/update/validation.
#    This is the FASTEST way to flush out wrong ruleKey values and bad parameter shapes.
#    Writes validation_<name>.json per workflow — read them for structured errors.
node main/clone_workflow_rules.js --apply \
  --collect-dir logs/collected_<ts> \
  --update --validate-only

# 6. Review validation_*.json, extend SYSTEM_RULE_KEY_MAP / CONFIG_KEY_BUCKETS as needed,
#    re-run step 5 until clean. Then:
node main/clone_workflow_rules.js --apply \
  --collect-dir logs/collected_<ts> \
  --update
```

## Recommended Runbook — Clone to Another Instance

```bash
# 1. Source .env → collect
node main/clone_workflow_rules.js --collect --all-workflows

# 2. Swap CLOUD_BASE_URL and CLOUD_API_TOKEN in .env to target instance

# 3. Validate first
node main/clone_workflow_rules.js --apply \
  --collect-dir logs/collected_<ts> \
  --validate-only

# 4. For real — creates <name>_v2 workflows on target
node main/clone_workflow_rules.js --apply \
  --collect-dir logs/collected_<ts>

# 5. Re-point schemes + publish (target drafts)
node main/clone_workflow_rules.js --apply \
  --collect-dir logs/collected_<ts> \
  --assign-schemes --publish
```

## Recommended Runbook — ScriptRunner Rules → SMS

```bash
# Generates scriptrunner-scaffold/ inside the collect dir
node main/clone_workflow_rules.js --collect --all-workflows \
  --export-scriptrunner-scaffold

# Then follow scriptrunner-scaffold/README.md for SMS deploy steps.
# Groovy script content is NOT available via the Jira API — stubs contain
# the original rule config as a comment and a TODO marker for operator paste-in.
```

---

## Output Files — What Each One Is For

All paths relative to `logs/collected_<timestamp>/`.

| File | Written by | Purpose |
|---|---|---|
| `metadata.json` | collect | Top-level summary: sourceUrl, collectedAt, list of workflow names, stats |
| `workflows/<name>.json` | collect | Raw workflow body from `GET /rest/api/3/workflow/search` — the source of truth; transformer reads these |
| `field_mapping.json` | collect | `{customfield_ID: "display name"}` from source. Used by `FieldMapper` at apply time to resolve by name on target |
| `id_mapping.json` | collect | Per-bucket catalog of every referenced entity ID → source-side name/context. The curation input. |
| `id_overrides.json.example` | collect | Skeleton file pre-populated with unresolved IDs. Rename to `id_overrides.json` and fill in target IDs to force-override auto-resolution |
| `id_overrides.json` | operator | Curated map of `{bucket: {sourceId: targetId | null}}`. Wins over auto-resolution by name. Null means drop. |
| `workflow_schemes.json` | collect | Per-project scheme data: `{projectKey, projectId, schemeId, schemeName, defaultWorkflow, issueTypeMappings}`. Used for `--assign-schemes`. Empty when `--collect --all-workflows` was used without `--project-keys`. |
| `statuses.json` | collect | Complete source status catalog. Informational only; the real remap data lives in `id_mapping.json`. |
| `scriptrunner-scaffold/` | collect (opt) | `extensions.yaml` + `groovy/**.groovy` stubs + `README.md` — SMS-compatible deploy descriptor for ScriptRunner rules |
| `id_remapping_<ts>.json` | apply | Audit: the full source→target ID map the applier computed (buckets + `_stats`) |
| `field_remapping_<ts>.json` | apply | Audit: custom field source→target ID resolution |
| `bulk_payload_<name>.json` | apply | The `POST /workflows/create` body for each workflow (create mode) |
| `update_payload_<name>.json` | apply | The `POST /workflows/update` body for each workflow (update mode) |
| `validation_<name>.json` | apply --validate-only | Validation endpoint's response: `{errors, warnings}` |
| `apply_<ts>.json` | apply | Execution report: per-workflow status, scheme results, skipped ScriptRunner rules |
| `dry_run/<name>.json` | apply --dry-run (create mode only) | Same as bulk_payload_<name>.json but in a dedicated subdir |

---

## Architecture

### Module responsibilities

```
main/clone_workflow_rules.js    CLI parsing, validation, orchestrator shell
  │
  ├─ src/workflowCollector.js     --collect orchestration
  │    ├─ resolves project schemes → workflow names
  │    ├─ fetches each workflow (saves raw JSON)
  │    ├─ scans workflows via referenceScanner
  │    ├─ resolves source-side entity catalogs to id_mapping.json
  │    └─ generates id_overrides.json.example skeleton
  │
  ├─ src/workflowApplier.js       --apply orchestration
  │    ├─ loads id_mapping + overrides → IdMapper.buildRemapping
  │    ├─ loads field_mapping → FieldMapper.buildMapping
  │    ├─ in --update: bulk-looks up target {id, version} by name
  │    ├─ per workflow: transform → build payload → POST create/update/validation
  │    └─ optionally: reassign schemes + publish drafts
  │
  ├─ src/workflowTransformer.js   PURE transformations — no API calls
  │    ├─ transformWorkflow(rawWorkflow, opts) → {payload, warnings, skippedSR}
  │    ├─ buildBulkCreatePayload — new create-API shape
  │    ├─ buildBulkUpdatePayload — new update-API shape (wraps create)
  │    ├─ convertConditionsTree — compound AND/OR preservation
  │    ├─ convertRuleToNewFormat — ruleKey inference + parameter coercion
  │    ├─ remapEmbeddedIdsInConfig — key-hint-driven ID rewriting
  │    ├─ remapEmbeddedIdsInValue — same, for JSON-stringified JMWE value blobs
  │    └─ remapFieldsInValue — customfield_NNN regex rewriting
  │
  ├─ src/referenceScanner.js      Scans workflow JSONs; outputs referenced ID buckets
  ├─ src/idMapper.js              Loads target catalogs; resolves source IDs by name
  ├─ src/fieldMapper.js           Custom-field name-based resolver
  ├─ src/scriptRunnerExporter.js  Emits SMS scaffold
  └─ src/jiraCloudClient.js       HTTPS client — retries, rate limiting, all endpoints
```

### Transformer pipeline (what happens to one workflow on --apply)

```
raw workflow JSON (from workflows/<name>.json)
    │
    ├─ strip status read-only properties (name, issueEditable)
    ├─ remap status.id via idRemapping.statuses
    │    → dropped statuses removed from workflow.statuses[]
    │
    ├─ for each transition:
    │    ├─ strip transition.id, screen.name
    │    ├─ remap transition.screen.id via idRemapping.screens
    │    ├─ remap transition.to via idRemapping.statuses (drop transition if null)
    │    ├─ remap transition.from[] via idRemapping.statuses
    │    ├─ conditionsTree → conditions (rename only, nodeType preserved)
    │    │
    │    ├─ processConditions (recursive):
    │    │    ├─ SR rule → mark for removal
    │    │    ├─ JMWE rule → clean prefix, strip config.id, remap fields in value,
    │    │    │              remap embedded IDs in parsed value JSON
    │    │    └─ other OOTB → walk config via remapEmbeddedIdsInConfig
    │    │
    │    ├─ processPostFunctions:
    │    │    ├─ drop if in SYSTEM_POST_FUNCTIONS_TO_STRIP
    │    │    ├─ FireIssueEventFunction → strip event.name, remap event.id
    │    │    ├─ SR rule → skip, record for scaffold
    │    │    ├─ JMWE rule → clean prefix, unwrap remoteWorkflowPostFunctionConfiguration,
    │    │    │              strip remoteWorkflowPostFunctionUUID, remap customfields +
    │    │    │              embedded IDs in value blob
    │    │    └─ other OOTB → walk config via remapEmbeddedIdsInConfig
    │    │
    │    └─ processValidators:
    │         ├─ FieldRequiredValidator: fields → fieldIds (new API rename)
    │         ├─ SR rule → skip, record
    │         ├─ JMWE rule → same treatment as above
    │         └─ other OOTB → walk config
    │
    └─ append --name-suffix to workflow name (skipped for --update)
        │
        └─ payload: { name, description, statuses, transitions }

┌──── buildBulkCreatePayload ────────────────────────────────────┐
│   Wraps payload in the new create-API shape:                    │
│   { scope, statuses[top-level], workflows: [{ name, ... }] }    │
│   Converts rule types to {ruleKey, parameters}                  │
└─────────────────────────────────────────────────────────────────┘

┌──── buildBulkUpdatePayload ────────────────────────────────────┐
│   Calls buildBulkCreatePayload, then rewraps:                   │
│   { statuses[top-level], workflows: [{ id, version, ... }] }    │
│   Drops `name`, drops `scope`, adds target {id, version}        │
└─────────────────────────────────────────────────────────────────┘
```

---

## The Hint Tables — How Embedded-ID Remapping Works

Many entity IDs live inside rule configuration objects (not at deterministic workflow-level paths). Two independent hint tables are maintained in parallel:

- **`EMBEDDED_KEY_HINTS`** in `src/referenceScanner.js` — tells the scanner which keys carry entity IDs during collection
- **`CONFIG_KEY_BUCKETS`** in `src/workflowTransformer.js` — tells the remapper which keys to translate during apply

**Rule of thumb: when you find a new rule type in real data that references an entity ID we don't currently catch, add the key to BOTH tables with the correct bucket name.** The bucket names are: `statuses`, `issueTypes`, `screens`, `events`, `projectRoles`, `priorities`, `resolutions`, `linkTypes`, `securityLevels`, `groups`, `users`.

Supported value shapes per key:

- Scalar: `priorityId: "1"` → treated as single ID
- CSV string: `statusIds: "5,6,7"` → split on `,`, each element is an ID
- Array of scalars: `statusIds: [5, 6]` → each element is an ID
- Array of objects: `projectRoles: [{id, name}]` → each element's `.id` is remapped
- Object with `.id`: `previousStatus: {id, name}` → `.id` is remapped

## System Rule-Key Map (`SYSTEM_RULE_KEY_MAP`)

Location: `src/workflowTransformer.js`. This is the single biggest unknown in the whole codebase. Atlassian's new `POST /rest/api/3/workflows/create` and `/workflows/update` APIs key rules by a `ruleKey` string (e.g. `system:check-permission-validator`, `connect:<appKey>__<moduleKey>`, `forge:<ari>`). But there is **no official public mapping table** from old-API type names (`PermissionValidator`, `FieldRequiredValidator`, etc.) to new ruleKeys.

**Verified from Atlassian docs examples:**

| Old type | New ruleKey | Notes |
|---|---|---|
| `PermissionValidator` | `system:check-permission-validator` | verbatim from docs |
| `ValueFieldCondition` | `system:check-field-value` | verbatim from docs |
| `FieldRequiredValidator` | `system:validate-field-value` | `paramsMapper` adds `ruleType: "fieldRequired"` + renames `fields`→`fieldIds` CSV |
| `FieldChangedValidator` | `system:validate-field-value` | `paramsMapper` adds `ruleType: "fieldChanged"` |

**Best-guess fallbacks (will probably fail `--validate-only`):**

All other OOTB types fall through to `system:<TypeName>` verbatim. This is known to be wrong for most of them — but without a reference table the only way to complete it is to run `--validate-only` against a target and read the error responses.

The 10 OOTB types observed in real data awaiting ruleKey mapping:

- `PermissionCondition`
- `InAnyProjectRoleCondition` (used 1886 times — high priority)
- `InProjectRoleCondition`
- `UserInAnyGroupCondition` (253 uses — high priority)
- `AlwaysFalseCondition`
- `UpdateIssueFieldFunction` (410 uses — high priority)
- `ClearFieldValuePostFunction`
- `AssignToCurrentUserFunction`
- `AssignToReporterFunction`
- `SetIssueSecurityFromRoleFunction`
- `DateFieldValidator`
- `ParentStatusValidator`
- `PreviousStatusCondition`
- `UserIsInCustomFieldCondition`
- `AllowOnlyAssignee`, `AllowOnlyReporter`
- `RemoteOnlyCondition`, `BlockInProgressApprovalCondition`, `OnlyBambooNotificationsCondition`
- `InGroupCFCondition`

---

## Known Gaps & Limitations

### Event resolution
`/rest/api/3/events` returns only a subset of events (system events + some customs). 90%+ of custom events in the sample instance returned `name: null`. `FireIssueEventFunction.event.name` is empty for custom events too. **Operator must provide overrides in `id_overrides.json` for custom events, OR re-create the events on target with matching names beforehand.**

### ScriptRunner script content
Jira's REST API doesn't expose ScriptRunner Groovy bodies — only the Connect rule reference is stored. `--export-scriptrunner-scaffold` emits stubs; operator must paste in Groovy manually from the source instance's ScriptRunner Script Manager or from DC if migrating.

### JMWE `transition` references by name
`TransitionIssueFunction` references target transitions by name (e.g. `"transition": "Timesheet Integration Hidden"`). Transition names don't need cross-instance ID translation, but they do need to exist with the same name on target.

### User accountId and group name CSVs
JMWE `EmailIssueFunction` uses `toUsers: "accountId:XXX,accountId:YYY"` and `toGroups: "group1,group2"`. These are NOT auto-remapped. AccountIds are Atlassian-org-scoped and group names are stable; operator handles user/group provisioning separately if doing cross-org moves.

### Forge apps beyond ARI
Only one Forge rule seen in the sample (`ari:cloud:ecosystem::extension/...`). The converter assumes `forge:<ari>` as the correct new-API prefix — unverified.

### Connect apps other than JMWE
No special handling for Elements Copy & Sync, Automation for Jira, or any other Connect app's rule bodies. The JMWE-specific cleanups (`remoteWorkflowPostFunctionUUID` unwrap, corrupted prefix normalisation) don't apply to them. Their `configuration.value` may still go through the generic embedded-ID remapper if keys match the hint table.

### Scheme re-assignment assumes matching scheme IDs
`--assign-schemes` updates each `workflow_schemes.json` entry using the source `schemeId`. This works when source and target are the same org (scheme IDs are stable) but would fail cross-org without a scheme lookup-by-name step. Not needed for `--update` mode (workflows update in place, schemes already point at them).

---

## Confidence Matrix

| Component | Confidence | Gating risk |
|---|---|---|
| Endpoints & pagination | **High** | Verified against Atlassian docs + existing repo usage |
| Collect against live instance | **High** | Ran twice against `your-sandbox.atlassian.net` successfully |
| Field remap (customfield_NNN) | **High** | Existing `FieldMapper` pattern (name lookup with `(migrated)` preference) proven in other scripts |
| JMWE prefix cleanup + UUID unwrap | **High** | Ported from `jira/apps/jmwe/workflows_fixer_for_jmwe.py` (production-tested) |
| Status/screen structural remap | **High** | Unit-tested with transition-drop semantics |
| Compound condition tree | **High** | Real compound tree in data; preserved nodeType/operator; converter wraps correctly |
| Hint table coverage | **Medium-High** | Tuned against 220 real workflows with 18 rule types; rare Connect apps/Forge apps unverified |
| ID override curation UX | **High** | Skeleton file pre-populated with unresolved IDs; operator only fills what matters |
| `buildBulkUpdatePayload` shape | **Medium-High** | Unit-tested; docs-verified; not hit live yet |
| **`SYSTEM_RULE_KEY_MAP` for OOTB rules** | **Low** | 2 verified mappings out of ~15 OOTB types in use. Expected to need iteration via `--validate-only`. |
| Forge ARI handling | **Low-Medium** | One sample; assumed `forge:` prefix |
| 409 optimistic-lock handling | **Low** | Error bubbles up as generic apply failure; operator would re-collect and retry |

---

## Next Steps — Concrete Todo For The Next AI Or Operator

Prioritised; tackle in order.

### 1. Run `--apply --update --validate-only` against a live target. [biggest unlock]
This is the single highest-value action. The validation endpoint returns structured errors that map 1:1 to fixes needed in `SYSTEM_RULE_KEY_MAP` and `convertRuleToNewFormat`. Without this roundtrip, every `ruleKey` beyond the two verified ones is a guess.

```bash
node main/clone_workflow_rules.js --apply \
  --collect-dir logs/collected_<ts> \
  --update --validate-only
```

Then read `logs/collected_<ts>/validation_*.json`. Typical errors:

- `Unrecognised ruleKey: system:XxxCondition` → add to `SYSTEM_RULE_KEY_MAP`
- `Parameter 'foo' must be a string` → extend `paramsMapper` for that rule
- `Missing required parameter 'bar'` → add to `paramsMapper`
- `Status reference 'uuid' not declared in statuses[]` → bug in `buildBulkCreatePayload`'s status gathering

### 2. Extend the rule-key map based on validation errors

Location: `src/workflowTransformer.js`, constant `SYSTEM_RULE_KEY_MAP`. Add entries like:

```js
UpdateIssueFieldFunction: {
  ruleKey: "system:???", // the ruleKey the validator asks for
  paramsMapper: (cfg) => ({
    fieldId: String(cfg.fieldId || ""),
    fieldValue: String(cfg.fieldValue ?? ""),
  }),
},
```

Re-run `--validate-only` after each change; iterate until all workflows return clean.

### 3. Provide custom event overrides

Most of the sample instance's 140 referenced events have `name: null` in `id_mapping.json`. Before `--apply`, the operator should:

- Either re-create the same custom events on target (matching names/IDs)
- Or fill `id_overrides.json`'s `events` bucket with `{sourceId: targetId}` pairs sourced from System → Events on the target instance

### 4. Handle optimistic-lock 409s gracefully

Currently a `POST /workflows/update` 409 bubbles up as a generic failure. Add retry-after-re-lookup:

```js
if (err.statusCode === 409) {
  const fresh = await this.client.getWorkflowsByNames([wfEntry.name]);
  if (fresh[0]) {
    targetInfo = { id: fresh[0].id, version: fresh[0].version };
    // rebuild payload, retry once
  }
}
```

Add to `src/workflowApplier.js` around the `updateWorkflowsBulk` call.

### 5. Verify Forge ARI handling

Only if you have Forge apps in your workflows. Run `--validate-only`; if Forge rules fail with `Unrecognised ruleKey`, the assumed `forge:<ari>` prefix is wrong. Adjust `convertRuleToNewFormat` at the `rule.type.startsWith("ari:")` branch.

### 6. (Optional) Handle status-removal migration task polling

If `--update` encounters status removals with in-use issues, the API returns a `taskId`. Currently the response is just logged — polling via `GET /rest/api/3/task/{taskId}` to completion would provide better UX. Mirror the `publishWorkflowSchemeDraft` → `pollTask` pattern already in `jiraCloudClient.js`.

### 7. (Optional) Add `--assign-schemes` lookup by scheme name

Currently assumes source scheme ID exists on target. For cross-org moves, add a lookup-by-name step before updating schemes.

---

## Testing

There is no formal test suite. Instead, inline smoke tests have been used heavily throughout development. Re-run them from the project root:

```bash
cd clone_workflow_rules

# Syntax check all files
for f in main/clone_workflow_rules.js src/*.js; do node --check "$f" || exit 1; done
echo ALL_OK

# Transformer helpers
node -e '
const { transformWorkflow, buildBulkCreatePayload, buildBulkUpdatePayload } = require("./src/workflowTransformer");
// ... (see smoke tests in git history / session transcript)
'
```

Full smoke-test scripts are in the conversation history that produced this codebase. The key ones:

- `transformWorkflow` status remap + transition drop
- `convertConditionsTree` compound AND/OR
- `buildBulkCreatePayload` 4 cases (target-IDs, remapped, missing-throws, explicit-null-drops)
- `buildBulkUpdatePayload` 6 cases (shape, throws on missing targetInfo, mappings pass-through)
- `referenceScanner.scanWorkflow` JMWE + OOTB key extraction
- Hint-table verification against real 220-workflow dataset

**Verification command against real collected data** (use any existing `logs/collected_*` dir):

```bash
node -e '
const fs = require("fs");
const path = require("path");
const { scanMany } = require("./src/referenceScanner");
const dir = "logs/collected_<ts>";
const wfs = fs.readdirSync(path.join(dir, "workflows"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, "workflows", f), "utf8")));
console.log(JSON.stringify(scanMany(wfs), null, 2));
'
```

---

## Troubleshooting

### `Cannot connect to Jira Cloud`
`CLOUD_BASE_URL` or `CLOUD_API_TOKEN` wrong. Verify with:
```bash
curl -H "Authorization: Basic $CLOUD_API_TOKEN" "$CLOUD_BASE_URL/rest/api/3/myself"
```

### `Status ID X (source Y) not found on target`
The target doesn't have a status whose ID matches `X`. Either:
- Create the status on target first (names don't have to match — only the ID), OR
- Add an override: `id_overrides.json` → `statuses: { "Y": "TARGET_STATUS_ID" }`, OR
- Drop it: `id_overrides.json` → `statuses: { "Y": null }` (also drops transitions using that status)

### `Workflow 'X' not present on target — nothing to update` (--update mode)
Target instance has no workflow with that name. Either:
- Create the workflow on target first (UI or separate `--apply` without `--update`), OR
- Expected — this workflow exists on source but not target; safe to skip

### `Cloud API POST /rest/api/3/workflow/ returned 404/410`
Legacy endpoint retired. Remove `--use-legacy-api`.

### `Cloud API rate limit exceeded`
Built-in retry with backoff handles 429. If it still fails, throttle by chunking workflows: run with `--workflow-names` on subsets rather than `--all-workflows`.

### Validation returns `Unrecognised ruleKey: system:PermissionCondition`
Expected — that rule's mapping is unverified. Extend `SYSTEM_RULE_KEY_MAP` based on the docs or try variants (e.g. `system:check-permission-condition`).

---

## Appendix — Atlassian API References

All verified 2026-04 against Context7's mirror of developer.atlassian.com.

| Endpoint | Purpose |
|---|---|
| `GET /rest/api/3/workflow/search` | Legacy workflow fetch (still works, returns the full old-shape body — what we collect from) |
| `POST /rest/api/3/workflows/create` | New bulk create |
| `POST /rest/api/3/workflows/create/validation` | Create validation (`{payload, validationOptions}`) |
| `POST /rest/api/3/workflows/update` | New bulk update (in-place) |
| `POST /rest/api/3/workflows/update/validation` | Update validation (`{payload, validationOptions}`) |
| `POST /rest/api/3/workflows` | Look up workflows by name; returns `{id, version}` needed for update |
| `GET /rest/api/3/statuses/search` | Paginated status catalog |
| `GET /rest/api/3/issuetype` | All issue types (bare array) |
| `GET /rest/api/3/screens?id=N` | Single screen lookup (no `/screens/{id}` exists — use the filter) |
| `GET /rest/api/3/role` | Project roles (bare array) |
| `GET /rest/api/3/priority/search` | Paginated priorities |
| `GET /rest/api/3/resolution/search` | Paginated resolutions |
| `GET /rest/api/3/issueLinkType` | `{issueLinkTypes: [...]}` |
| `GET /rest/api/3/events` | Bare array of `{id, name}` — system events only; custom events often missing |
| `GET /rest/api/3/issuesecurityschemes` | Security schemes; levels require a second GET per scheme |
| `GET /rest/api/3/group/bulk?groupName=X` | Post-GDPR group lookup by name → groupId |
| `GET /rest/api/3/field/search` | Custom field lookup |
| `GET /rest/api/3/workflowscheme` | Paginated scheme list |
| `PUT /rest/api/3/workflowscheme/{id}` | Update scheme (for `--assign-schemes`) |
| `POST /rest/api/3/workflowscheme/{id}/draft/publish` | Publish scheme draft (async; returns `{self}`, poll `/rest/api/3/task/{id}`) |

| Behaviour note | Source |
|---|---|
| Legacy `POST /rest/api/3/workflow/` retired 2026-02-01 | developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-workflows |
| `/workflows/create` auto-creates statuses named in top-level `statuses[]` | Same page, Bulk Create example |
| `/workflows/update` requires `id + version`; optimistic lock 409 on stale version | Same page, Update endpoint |
| `parameters` must be flat string map; booleans/numbers/JSON stringified | Same page, examples show `"excludeSubtasks": "true"` |
| `transition.type` enum: `INITIAL`, `GLOBAL`, `DIRECTED` (uppercase) | Same page |
| Compound conditions: `{nodeType: "compound"\|"simple", operator: "AND"\|"OR", conditions[]}` | Same page (example-only; no dedicated schema page) |

---

_Document last synchronised with code: 2026-04-23. When adding significant features, update the "Status — Handover Snapshot" section and the "Confidence Matrix"._
