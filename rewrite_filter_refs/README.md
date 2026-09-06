# rewrite-filter-refs

Post-migration JQL cleanup for Jira Cloud filters after a Data Center → Cloud
migration. JCMA (Jira Cloud Migration Assistant) copies filter *bodies* but
leaves four categories of references pointing at DC-era identifiers that don't
exist on Cloud. This tool finds and fixes them.

> ### org-admins share persistence (v2.4, 2026-06-11)
> Adding the org-admins group to a filter's **share** permissions only sticks if the
> filter's OWNER is itself org-admins-capable. Because the tool swaps the owner to do
> the JQL edit and then **restores the original owner**, Cloud silently DROPS the
> org-admins share whenever that restored owner isn't in org-admins. Two things were
> added: (1) the share-POST is now **verified** (re-read + retry) instead of trusting
> the 2xx — group-membership changes also propagate with a 1–2 min lag that made bare
> POSTs look successful while not persisting; (2) **`--no-owner-restore`** leaves each
> filter owned by the running (admin) account so the share survives — trade-off: the
> filters end owned by the migration account. The final report warns when shares
> didn't persist and points to this. Also note: the caller must be a member of every
> group a filter is already shared with (e.g. `Reporting Group`) or the permission edit
> is rejected wholesale.

**Version:** `2.3.0` (v1 rewrote filter IDs only; v2 added asset rewrites,
JQL sanitize, owner-swap + org-admins merge; v2.1 added cf[N] remap +
broken-function strip + project validation + reactive value-strip;
v2.2 adds direct Asset-field rewrites, ORDER BY clean for Asset fields,
auto-built DC→Cloud custom-field map, and the `customfield_N` long form
remap in the sanitizer; v2.3 adds proactive **priority name rewrites**
that auto-detect UI renames on Cloud and rewrite `priority = ...` JQL
accordingly).

---

## TL;DR

What it does (in one filter run):

```
GET  /rest/api/3/filter/search                            ── list every Cloud filter
per filter:
  extract refs in JQL  →  resolve DC→Cloud  →  rewrite JQL
  GET  /rest/api/3/filter/{id}                            ── fetch current owner+perms
  PUT  /rest/api/3/filter/{id}/owner                      ── swap owner → us
  PUT  /rest/api/3/filter/{id}  {jql, permissions}        ── atomic update
  PUT  /rest/api/3/filter/{id}/owner                      ── restore original owner
```

Outputs a resumable `logs/plan_<runId>.json` plus before/after CSV reports.

---

## Four classes of breakage it fixes

### 1. Stale DC filter-ID references

Cloud filters often embed **numeric DC filter IDs** in their JQL
(`filter = 12012`, `filter IN (12012, 13345)`, `savedFilter != 12012`). Those
numbers survive migration unchanged but resolve to the wrong Cloud filter (or
nothing). Name survives; ID doesn't.

```jql
-- before
project = FOO AND filter = 12012

-- after (filter matched by name on Cloud → new id 20045)
project = FOO AND filter = 20045
```

### 2. Stale Assets object references inside `aqlFunction("…")`

Cloud Assets (formerly Insight) regenerates **both object keys and numeric
object IDs** on import (see [Atlassian KB: Alternative solutions for migrating
JSM Cloud Assets Schema](https://support.atlassian.com/jira/kb/alternative-solutions-for-migrating-jsm-cloud-assets-schema-from-sandbox-to/)).
The only JQL function that references Assets on Cloud is
[`aqlFunction(aql)`](https://support.atlassian.com/jira-service-management-cloud/docs/assets-jql-functions/).
We rewrite four AQL fragments inside it:

```jql
-- before (CMDB-21171 / CMDB-21180 are DC keys)
"Asset Field" IN aqlFunction("Key IN (\"CMDB-21171\", \"CMDB-21180\")")

-- after (Cloud keys resolved via DC name → Cloud name)
"Asset Field" IN aqlFunction("Key IN (\"CMDB-14544\", \"CMDB-18820\")")
```

Names survive migration, so we match by name and lift the new key/id from
the Cloud side. See `src/aqlRewriter.js` for the exact fragments handled.

### 3. Post-JCMA JQL sanitizer (strict parser fixes)

Cloud's JQL parser rejects some syntax that DC accepted, and a handful of
JSM fields were renamed. Example from a real production filter (per the
screenshot a user shared):

```jql
-- before (Cloud error: "Field 'Customer Request Type' does not exist")
project = "Timesheet & Reporting Support"
  AND "Customer Request Type" = "Timesheet Account Configuration Changes (TAC)"
  AND (status = OPEN OR status = "WORK IN PROGRESS" OR status = Reopened)

-- after
project = "Timesheet & Reporting Support"
  AND "Request Type" = "Timesheet Account Configuration Changes (TAC)"
  AND (status = OPEN OR status = "WORK IN PROGRESS" OR status = Reopened)
```

And Cloud's strict parser:

```jql
-- before (Rovo suggests: "Unexpected character at line 1 column X")
labels not in (Test, TEST, Duplicated, Project) OR labels is EMPTY

-- after
labels NOT IN ("Test", "TEST", "Duplicated", "Project") OR labels IS EMPTY
```

Implemented in `src/jqlSanitizer.js`. Uppercase reserved words, quote bare
tokens in `IN (...)` lists, rename fields via a defaults + user-supplied
map. Reserved words (EMPTY, NULL, function calls) are never auto-quoted.

### 3a. Direct Asset-field references (v2.2)

Outside `aqlFunction(…)`, DC filters often reference Asset custom fields
directly: `"Development Team" = 14032`, `"Affected Device" IN ("HW-1", "HW-2")`,
or `"Development Team" = "ari:cloud:cmdb:…/27118"`. JCMA migrates the
literal value but Cloud Assets regenerates object IDs + keys on import
([Atlassian KB](https://support.atlassian.com/jira/kb/alternative-solutions-for-migrating-jsm-cloud-assets-schema-from-sandbox-to/)),
so those IDs/keys are stale. The documented Cloud syntax for direct refs
is the OBJECT NAME:

```jql
-- before
"Development Team" = 14032

-- after
"Development Team" = "Platform Squad"
```

The rewriter is opt-out (`--no-asset-field-rewrite`). It:

1. Auto-discovers which Cloud custom fields are Asset (CMDB) fields via
   `GET /rest/api/3/field/search?type=custom` (schema
   `com.atlassian.jira.plugins.cmdb:cmdb-object-cftype`).
2. Skips text inside `aqlFunction(…)` (the existing `aqlRewriter` handles it).
3. Classifies each value: ARI form → cloud objectId lookup; key form
   (e.g. `CMDB-21171`) → DC→Cloud key→name map; numeric → DC objectId map;
   anything else → assumed already a name (pass-through).
4. Records every rewrite in `asset_field_rewrites_<runId>.csv`.

See `src/assetFieldRewriter.js` for the regexes and resolution order.

### 3b. ORDER BY on Assets fields (v2.2)

Per Atlassian docs, ["users can't use an Assets object field to sort
search results in a JQL query"](https://support.atlassian.com/jira-service-management-cloud/docs/assets-jql-functions/).
DC filters with `ORDER BY "Development Team"` either 400 on PUT or
silently lose the sort.

`src/orderByCleaner.js` walks the outermost ORDER BY (quote-aware) and
drops only the asset-field entries. Non-asset entries are left intact;
the whole clause is removed only if every entry was an asset field.

Opt-out: `--no-order-by-clean`. Every strip is logged to
`order_by_stripped_<runId>.csv`.

### 3b2. Forge "Traffic Light" status fields (v2.2)

The 13-field "Traffic Light" family on this tenant (Team Priority, Health,
QA Complete, Setup Complete, Prod Env, etc., all using Forge extension type
`traffic-light-status-field-type`) stores its value as an object
`{ shape: "⚪🟡⚪", label: "Yellow" }`. JQL that compares against the plain
field name PARSES but matches zero rows:

```jql
-- before (parses, but returns 0 rows because comparison is against the object)
"Team Priority" in (Important, "Escalated")

-- after  (compares against the .label sub-field — the only one with semantic content)
"Team Priority.Label" in (Important, "Escalated")
```

The rewriter (`src/trafficLightFieldRewriter.js`) appends `.Label` to value
comparisons (`= != IN NOT IN ~ !~`) when the LHS is a quoted or bare
traffic-light field with no existing dot accessor. It leaves
`IS EMPTY` / `IS NOT EMPTY` clauses untouched (those work fine without the
accessor) and refuses to rewrite the `cf[N]` form because Cloud rejects
`cf[N].Label` with a 400 ("Expecting operator").

Opt-out: `--no-traffic-light-label`. Every change is logged to
`traffic_light_label_appends_<runId>.csv`.

### 3b3. Priority name rewrites (v2.3)

Cloud preserves priority **IDs** across JCMA migration but the visible
**name** is mutable. Operators commonly rename priorities by hand in the
Cloud UI after migration (`Critical` → `P0 - Critical`, `High` →
`P1 - High`, etc.). JQL stored at DC-name time then references stale
names and Cloud rejects PUTs with:

```
The value 'Critical' does not exist for the field 'priority'.
```

The reactive `jqlValueStripper` would **drop** the value, which is the
wrong behaviour for a rename — we want to **rewrite** to the current
Cloud name. The new rewriter does that proactively.

```jql
-- before  (Cloud has renamed Critical → "P0 - Critical")
project = FOO AND priority = Critical

-- after
project = FOO AND priority = "P0 - Critical"
```

How the map is built (`src/priorityMapBuilder.js`):

1. `GET /rest/api/2/priority` on DC (flat array).
2. `GET /rest/api/3/priority/search` on Cloud (paginated; falls back to
   `GET /rest/api/3/priority` on older tenants).
3. Pair by `id` — JCMA keeps priority IDs stable, so this surfaces the
   "live" Cloud name for every DC priority. Identity pairs (same name
   case-insensitively) are filtered out at build time.
4. The manual `--priority-map <path>` file (CSV `dc_name,cloud_name` or
   JSON `{"DC":"Cloud"}`) is merged on top — manual entries win on
   conflict, mirroring the `--cf-map` convention.

What the rewriter (`src/priorityRewriter.js`) handles:

- `priority = X`, `priority != X`
- `priority IN (X, Y)`, `priority NOT IN (X, Y)`
- Bare and quoted values; values containing whitespace are emitted with
  double-quotes so the sanitizer's IN-list quoting doesn't fight us.

What it deliberately leaves alone:

- `priority IS [NOT] EMPTY` (no value)
- `ORDER BY priority` (no value)
- `priority WAS …` / `priority CHANGED …` (history operators — out of
  scope v1)
- `priority = 1` (numeric ID form — IDs survive JCMA unchanged)

Opt-out: `--no-priority-rewrite`. Every rewrite is logged to
`priority_rewrites_<runId>.csv`, and the merged map is dumped to
`priority_map_cache_<runId>.json` for inspection.

### 3c. Auto-built DC→Cloud custom-field map (v2.2)

The v2.1 `--cf-map <path>` flag forces operators to build a CF map by
hand. v2.2 adds a live builder that does it automatically:

- `GET /rest/api/2/field` on DC.
- `GET /rest/api/3/field/search?type=custom&expand=key` on Cloud.
- Pair by NFC-normalized lowercased name. First-wins on duplicates;
  every collision is logged.
- The result is written to `logs/field_map_cache_<runId>.json` for
  reuse / inspection.

Both wire forms get rewritten now: the bracket `cf[NNNN]` AND the long
`customfield_NNNN` form. Manual `--cf-map` still wins on conflict so
operators can override.

Opt-out: `--no-auto-cf-map`. Implementation: `src/fieldMapBuilder.js`.

### 3d. Share-permission POST workaround (v2.2)

Cloud has a [documented quirk](https://community.atlassian.com/forums/Jira-questions/Updating-Share-Permissions-using-PUT-rest-api-2-filter-id-does/qaq-p/2189785):
`PUT /rest/api/3/filter/{id}` with `sharePermissions` in the body returns
200 OK but **does not actually persist** the new shares. `editPermissions`
on the same PUT IS persisted — they're asymmetric. We must use
`POST /rest/api/3/filter/{id}/permission` to add a share entry.

The state machine now has a **Step 3.5** between the JQL PUT and owner
restore: after a successful PUT, if `--share-org-admins` is on and the
original sharePermissions did not contain org-admins, the processor calls
POST to add it. The POST is idempotent (skipped when already present) and
its failure does NOT regress the JQL update — it just gets logged on the
plan entry for follow-up.

### 3e. Permissions-only sweep (v2.2 — `main/ensure_permissions.js`)

The JQL rewriter only adds org-admins to filters that *also* need a JQL
PUT. Filters with no JQL changes (no_change, skipped, failed) never get
org-admins via the main script. The new standalone tool covers them:

```bash
node main/ensure_permissions.js --dry-run
node main/ensure_permissions.js                  # full apply
node main/ensure_permissions.js --avoid-overwrite # extra safety
```

It walks every Cloud filter, classifies them by what's missing, and runs:
owner-swap → PUT (only if edit needs org-admins) → POST (only if share
needs org-admins) → owner-restore. Filters already correct are
`no_change` and never touched. Resumable like the main script.

### 4. Owner-swap + org-admins permissions merge (Phase 2 only)

Writes in Phase 2 fail with HTTP 403 whenever the calling user isn't the
filter owner. Rather than asking the operator to impersonate each owner,
the tool temporarily swaps ownership to the current user, does the PUT,
then restores the original owner. As part of the same update it merges
the `org-admins` group into both `sharePermissions` and `editPermissions`
so ops can edit the filter going forward. See "Phase 2 state machine"
below.

---

## Architecture

### Phase 1: buildPlan (read-only plan generation)

Pipeline per Cloud filter — each stage is a pure, unit-tested module:

```
originalJql
   │
   ▼   (src/jqlRewriter.js : rewriteJql)
jql1 = filter-ref rewrite  ── replaces `filter = 12012` → `filter = 20045`
   │
   ▼   (src/jqlRewriter.js : rewriteAqlFunctionBodies → src/aqlRewriter.js : rewriteAql)
jql2 = asset-ref rewrite   ── replaces Key / objectId inside aqlFunction("…")
   │
   ▼   (src/jqlSanitizer.js : sanitizeJql)
jql3 = sanitizer pass      ── field renames, operator casing, IN-list quoting
   │
   ▼
rewrittenJql
```

Each pass records its own changes on the plan entry (`refs[]`,
`aqlReplacements[]`, `sanitizerChanges[]`) so the CSV reports can attribute
every edit to its stage.

### Phase 2: executePlan — six-step state machine per filter

Implemented in `src/filterProcessor.js :: _executeOne()`. Every transition
is persisted to the plan so SIGINT-then-resume is safe between any two
steps.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. pre-fetch (if plan lacks originalOwner / original{Share,Edit}Perms) │
│     GET /rest/api/3/filter/{id}?expand=…                                │
│     • captures originalOwner, original{Share,Edit}Permissions           │
│     • if --verify-name and jql changed since plan → skip                │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                  skip if caller already is owner
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  2. owner-swap     PUT /rest/api/3/filter/{id}/owner {accountId: US}    │
│     executionPhase: "owner_swapping" → "owner_swapped"                  │
│     on failure → executionPhase=failed, DO NOT restore (never swapped)  │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  3. atomic update  PUT /rest/api/3/filter/{id}                          │
│     { name, jql: rewrittenJql, description,                             │
│       sharePermissions: merged, editPermissions: merged }               │
│     skipped if data.jqlUpdated already true (resume)                    │
│     merged = original ++ {type: "group", group: {groupId, name}}        │
│     executionPhase: "updating" → "updated"                              │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
           attempted even if step 3 failed, iff we swapped
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  4. owner-restore  PUT /rest/api/3/filter/{id}/owner {accountId: orig}  │
│     executionPhase: "owner_restoring" → "done" | "failed"               │
│     on failure → orphaned_owner_swaps_<runId>.csv + loud summary line   │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  5. finalize status: completed | failed | skipped                       │
└─────────────────────────────────────────────────────────────────────────┘
```

**Important invariant:** Cloud's `PUT /filter/{id}` replaces
`sharePermissions` and `editPermissions` **wholesale**. Passing `[]` would
wipe all existing shares. So:

- When we are merging org-admins, we **always** pass the full merged list
  (`original + orgAdminsEntry`), never `[]`.
- When we are **not** merging (flag `--no-share-org-admins` or the group
  lookup failed), we **omit** the permissions fields from the PUT body
  entirely so Cloud preserves whatever's there.

This was an actual bug fixed after review — see
`src/filterProcessor.test.js`, test "shareOrgAdmins=false → PUT body omits
sharePermissions/editPermissions entirely".

---

## Directory layout

```
rewrite-filter-refs/
├── README.md                          this file
├── package.json                       npm scripts; dotenv-only dep
├── .env.example                       template for .env
├── main/
│   └── rewrite_filter_refs.js         CLI entry, argv parsing, orchestration, final report
├── src/
│   ├── cloudJiraClient.js             Cloud HTTPS client w/ 429/5xx retry
│   ├── datacenterClient.js            DC HTTP(S) client w/ retry
│   ├── cloudAssetsClient.js           Cloud Assets (Insight) client (COPIED from sibling)
│   ├── jqlRewriter.js                 filter-ref rewrite + aqlFunction scanner (pure)
│   ├── aqlRewriter.js                 AQL body rewrite for Key / objectId (pure)
│   ├── jqlSanitizer.js                field rename + operator casing + IN quoting + cf-remap (pure)
│   ├── assetFieldRewriter.js          direct Asset-field ref rewrite outside aqlFunction (pure, v2.2)
│   ├── orderByCleaner.js              strip ORDER BY on Asset fields (pure, v2.2)
│   ├── fieldMapBuilder.js             live DC↔Cloud custom-field map builder (v2.2)
│   ├── priorityMapBuilder.js          live DC↔Cloud priority name map builder, paired by id (v2.3)
│   ├── priorityRewriter.js            pure priority-value JQL rewriter (v2.3)
│   ├── filterMapper.js                DC id ↔ DC name ↔ Cloud id caches
│   ├── assetMapLoader.js              preloads DC→Cloud asset maps from sibling plans
│   ├── ownerSwap.js                   thin wrapper: swap / restore owner
│   ├── permissions.js                 org-admins group lookup + idempotent merge
│   ├── planManager.js                 plan + master JSON persistence + resume
│   ├── reportWriter.js                all CSV output writers
│   ├── filterProcessor.js             buildPlan + executePlan orchestration
│   │
│   ├── jqlRewriter.test.js            24 tests — filter-ref + aqlFunction scanner
│   ├── aqlRewriter.test.js            13 tests — AQL fragment rewrites
│   ├── jqlSanitizer.test.js           18 tests — sanitizer transforms
│   ├── permissions.test.js             8 tests — merge idempotency + stripForWrite
│   └── filterProcessor.test.js        12 tests — integration via mocked Cloud client
└── logs/                              auto-created at runtime
```

---

## Module reference (file, purpose, key functions)

### `main/rewrite_filter_refs.js`

Entry point. Flow:

1. Parse argv (manual loop, matches repo convention).
2. Load `.env` via `dotenv`.
3. Validate required env. Open logs file.
4. Test Cloud connectivity. Resolve current user (`GET /rest/api/3/myself`)
   for owner-swap.
5. Resolve `org-admins` group (`GET /rest/api/3/groups/picker`) before any
   writes — fail fast if the group doesn't exist.
6. Parse `--rename-fields` CSV/JSON.
7. Load DC→Cloud asset map from sibling plan files via
   `assetMapLoader.loadAssetMaps()`.
8. Build processor, wire everything. Run Phase 1 and/or Phase 2.
9. Install SIGINT/SIGTERM handlers that flush the plan.

Key locations:

- Arg parsing: `main/rewrite_filter_refs.js:17-61`
- Env validation: `main/rewrite_filter_refs.js:113-119`
- Current user + org-admins lookup: `main/rewrite_filter_refs.js:184-232`
- Asset-map preload: `main/rewrite_filter_refs.js:260-285`
- Signal handlers: `main/rewrite_filter_refs.js:~340`

### `src/cloudJiraClient.js`

Single `makeRequest()` over native `https`. Basic auth
`Authorization: Basic ${base64(email:apiToken)}`. 30s timeout. 3-retry
exponential backoff for 5xx and 429 (honors `Retry-After`).

Methods:

| Method | Endpoint | Notes |
|---|---|---|
| `testConnection()` | `GET /rest/api/3/serverInfo` | |
| `getCurrentUser()` | `GET /rest/api/3/myself` | returns `{ accountId, emailAddress, displayName }` |
| `searchAllFilters({expand, limit})` | `GET /rest/api/3/filter/search` | paginated; default expand: `jql,owner,description,sharePermissions,editPermissions` |
| `getFilter(id, {expand})` | `GET /rest/api/3/filter/{id}` | default expand includes permissions |
| `searchFilterByName(name)` | `GET /rest/api/3/filter/search?filterName=…&isSubstringMatch=false` | |
| `updateFilter(id, {name, jql, description, sharePermissions, editPermissions})` | `PUT /rest/api/3/filter/{id}` | any `undefined` field is omitted from body |
| `setFilterOwner(id, accountId)` | `PUT /rest/api/3/filter/{id}/owner` | body: `{accountId}` |
| `pickGroup(name)` | `GET /rest/api/3/groups/picker?query=…` | exact-match lookup, returns `{ groupId, name } \| null` |

References:

- [Filters API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-filters/)
- [Filter sharing API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-filter-sharing/)
- [Groups API — groups/picker](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-groups/#api-rest-api-3-groups-picker-get)

### `src/datacenterClient.js`

Mirror of the Cloud client but speaks DC. Raw `username:password` Basic
auth. Supports `http://` and `https://`. Only two methods used today:

| Method | Endpoint | Returns |
|---|---|---|
| `testConnection()` | `GET /rest/api/2/serverInfo` | |
| `getFilter(id)` | `GET /rest/api/2/filter/{id}` | `null` on 404 |

Reference: [DC Filter API v11003](https://developer.atlassian.com/server/jira/platform/rest/v11003/api-group-filter).

### `src/cloudAssetsClient.js`

**Copied verbatim** from
`jira/jira-data/sync_asset_ticket_associations/src/cloudAssetsClient.js`.
Only used when `--asset-live-fallback` is set. Kept as a full copy (not a
cross-`require`) so this script stays self-contained; if the sibling
improves its client, this copy may need manual re-sync.

API base: `/jsm/assets/workspace/{workspaceId}/v1`.

Key methods for our use:

- `findObjectsByKeys(keys)` → batch AQL `Key IN (…)`
- `findObjectsByNames(names)` → batch AQL `Name IN (…)`
- `getObjectById(objectId)` → direct GET `/object/{id}`

References:

- [Assets Cloud REST API](https://developer.atlassian.com/cloud/assets/rest/)
- [AQL (Assets Query Language)](https://support.atlassian.com/assets/docs/use-assets-query-language-aql/)

### `src/jqlRewriter.js`  (pure, no I/O)

Two concerns bundled:

- **Filter-ref rewrite** — the original v1 behavior. `extractFilterIds(jql)`
  + `rewriteJql(jql, dcToCloudMap)`. Handles `filter` / `savedFilter`,
  `=`, `!=`, `IN`, `NOT IN`, quoted numeric operands, and IN-list
  per-token rewriting.
- **aqlFunction scanner** — `rewriteAqlFunctionBodies(jql, aqlRewriteFn)`.
  Regex `\baqlFunction\s*\(\s*"…"\s*\)` with escape-aware quote matching.
  Unescapes the inner body (`\"` → `"`, `\\` → `\`), hands it to
  `aqlRewriteFn`, re-escapes the result, and splices back.

24 tests in `jqlRewriter.test.js`.

### `src/aqlRewriter.js`  (pure, no I/O)

Rewrites four AQL fragments using two maps
(`dcKeyToCloudKey`, `dcObjectIdToCloudObjectId`):

| Regex | Covers |
|---|---|
| `KEY_EQ_RE` | `Key = "…"` and `Key != "…"` |
| `KEY_IN_RE` | `Key IN (…)` and `Key NOT IN (…)` |
| `OBJID_EQ_RE` | `objectId = N` and `objectId != N` |
| `OBJID_IN_RE` | `objectId IN (…)` and `objectId NOT IN (…)` |

Returns `{ rewritten, replacements, unresolved }`. Unresolved items are
tagged `"key:CMDB-99999"` or `"objectId:123"` for the CSV report. Non-matching
AQL (e.g. `Name = "…"`, `objectType = Server`, `Host.Virtual = true`)
passes through unchanged.

13 tests in `aqlRewriter.test.js`. Splitting respects paren/quote depth
(`splitTopLevelCommas()`), so commas inside quoted strings or inner parens
don't break the rewrite.

### `src/jqlSanitizer.js`  (pure, no I/O)

Two-stage operation:

1. **Segment split**: walk the string once, alternating quoted / unquoted
   segments. Understands `"…"` and `'…'` with `\"` / `\'` escapes.
2. **Transforms** (only on unquoted segments, unless noted):
   - **Field rename**: `"Customer Request Type" → "Request Type"`
     (built-in) plus any user-supplied pairs. Applied inside quoted
     segments when the whole quoted text equals a rename key (i.e. `"X"`
     used as a field identifier).
   - **Uppercase reserved ops**: `not in`, `in`, `is empty`,
     `is not empty`, `and`, `or`, `not`, `was`, `changed`.
   - **IN-list quoting**: inside `IN (…)` and `NOT IN (…)`, wrap bare
     identifier tokens in `"…"`. Never quotes reserved words (`EMPTY`,
     `NULL`, etc.) or function calls.

18 tests in `jqlSanitizer.test.js`. Known imperfection: the segment
splitter is a naive state machine, not a full JQL parser. Crafted input
mixing inner quotes in exotic ways could confuse it. See test case
"operator uppercasing does not corrupt identifiers" for a regression
guard against `Information` being uppercased into `InformatION`.

### `src/assetMapLoader.js`

Reads `../sync_asset_ticket_associations/logs/plan_*_*.json` files and
builds DC→Cloud maps by pairing each issue's `dcAssets: [{key,name}]`
with its `cloudAssets: [{objectId, objectKey, name}]`. Matches by
NFC-normalized lowercased name. Uses `fs.readFileSync + JSON.parse`
(not streaming) — fine for typical sizes (tested with 30 files, 1.18M
issues, 3,508 unique DC→Cloud keys, zero collisions).

Output:

```js
{
  dcKeyToCloudKey:          Map<string, string>,
  dcKeyToCloudObjectId:     Map<string, string>,
  dcNameToCloudKey:         Map<string, string>,   // lowercased keys
  dcNameToCloudObjectId:    Map<string, string>,
  dcObjectIdToCloudObjectId: Map<string, string>,  // reserved; unpopulated
                                                   //  (sibling plans don't include DC objectIds)
  collisions: [{ dcKey, candidateCloudKeys: [...] }],
  stats: { filesScanned, issuesScanned, dcKeysLearned, collisions }
}
```

**Limitation:** `dcObjectIdToCloudObjectId` is currently always empty
because the sibling script resolves by key/name, not by DC objectId. If
a Cloud filter references `objectId = 14032` (a pure DC numeric id that
never appears on Cloud), we have no way to translate it via sibling
plans. Use `--asset-live-fallback` to query the Cloud Assets API by name
— but that only works if the DC objectId was recorded somewhere we can
reach.

### `src/ownerSwap.js`

Two-line wrappers (`swapOwner`, `restoreOwner`) around
`cloudClient.setFilterOwner(id, accountId)`. Pure indirection so the
state machine code reads naturally.

### `src/permissions.js`

- `resolveOrgAdminsGroup(client, {groupName})` — uses
  `cloudClient.pickGroup()`, returns `{groupId, name}` or throws (fail
  fast at startup so we don't discover the group is missing mid-run).
- `mergePermissions(existing, groupRef)` — idempotent additive merge
  that matches on `groupId` first, then `name`. Never duplicates; never
  drops existing entries.
- `stripForWrite(permissions)` — drops server-assigned fields
  (permission `id`, group `self`, project `name`/`key`, role `name`) so
  the PUT body is minimal and portable.
- `isGroupMatch(entry, groupRef)` — boolean helper used by merge.

8 tests in `permissions.test.js`.

### `src/planManager.js`

Two files per run:

- `logs/master_<runId>.json` — small index with run-level stats and a
  pointer to the plan file. Human-readable, re-written on every stat
  change.
- `logs/plan_<runId>.json` — per-filter entries keyed by Cloud filter id.
  Streamed writer puts each filter on its own line, so the loader can
  stream via `readline` without blowing up memory on large plans.
  Auto-saves every 500 updates and on SIGINT.

Key methods:

- `createMasterIndex(runId)` / `saveMasterIndex()` / `loadMasterIndex()` / `findLatestMasterIndex()`
- `createPlan(runId, filtersMap)` — bumps version to `"2.0"`.
- `loadPlan(path)` — streaming. Handles v1 plans (missing v2 fields
  default at read time in the consumer).
- `getFiltersToProcess(retryFailed)` — returns `[cloudId, data]` pairs
  for anything `status === "pending"`, `retryFailed && "failed"`, or
  any filter with a non-terminal `executionPhase` (resume-safety).
- `updateFilterStatus(id, status, err)` — writes `status`, `error`,
  `updatedAt`. Auto-save tracked.
- `updateFilterEntry(id, partial)` — **v2 addition.** Merges arbitrary
  fields into the entry for state-machine bookkeeping.

### `src/reportWriter.js`

All CSV outputs. CSV-escape via `csvEscape()` (handles commas, quotes,
newlines).

| Method | File | Columns |
|---|---|---|
| `writeUnresolved(filtersMap)` | `unresolved_refs_<runId>.csv` | `kind, cloudFilterId, cloudFilterName, dcId, reason, details` |
| `writeCollisions(filtersMap)` | `collisions_<runId>.csv` | `kind, cloudFilterId, cloudFilterName, dcId, dcName, candidateCloudIds` |
| `writeRewrites(filtersMap)` | `rewrites_<runId>.csv` | `cloudFilterId, cloudFilterName, status, originalJql, rewrittenJql, error` |
| `writeOrphanedOwnerSwaps(filtersMap)` | `orphaned_owner_swaps_<runId>.csv` | `cloudFilterId, cloudFilterName, originalOwnerAccountId, originalOwnerDisplayName, currentOwnerAccountId, executionPhase, lastStepError` |
| `writeAssetCollisions(collisions)` | `asset_collisions_<runId>.csv` | `dcKey, candidateCloudKeys` |

The `kind` column distinguishes `filter`, `asset:key`, `asset:objectId`.

### `src/filterProcessor.js`

Both `buildPlan(runId)` and `executePlan()` live here. The interesting
method is `_executeOne(cloudId, data)` — the 6-step state machine. See
"Architecture › Phase 2" above for the flow diagram.

Key locations:

- Constructor + option defaults: `src/filterProcessor.js:20-72`
- 4-pass build pipeline: `src/filterProcessor.js:~130-250`
- 6-step state machine (`_executeOne`): `src/filterProcessor.js:~450-710`

---

## Plan file schema (v2)

```json
{
  "version": "2.0",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "stats": { "total": 0, "pending": 0, "completed": 0, "failed": 0, "skipped": 0, "no_change": 0 },
  "filters": {
    "10234": {
      "status": "pending | completed | failed | skipped | no_change",
      "name": "Open bugs for my team",

      /* v1 compat (still written) */
      "owner": { "accountId": "...", "displayName": "..." },

      /* v2 owner-swap machinery */
      "originalOwner":            { "accountId": "...", "displayName": "..." },
      "originalSharePermissions": [ /* captured from live GET */ ],
      "originalEditPermissions":  [ /* captured from live GET */ ],
      "ownerSwapped":     false,
      "ownerRestored":    false,
      "jqlUpdated":       false,
      "permissionsAdded": false,
      "executionPhase":   "idle | owner_swapping | owner_swapped | updating | updated | owner_restoring | done | failed",
      "lastStepError":    null,
      "currentOwnerAccountId": "...",

      /* the JQL edit */
      "originalJql":  "project = FOO AND filter = 12012",
      "rewrittenJql": "project = FOO AND filter = 20045",
      "description":  "",

      /* stage 1: filter-ref resolution per unique DC id */
      "refs": [
        { "kind": "filter", "dcId": "12012", "dcName": "Team backlog", "cloudId": "20045", "resolution": "ok" },
        { "kind": "filter", "dcId": "99999", "resolution": "dc_deleted" },
        { "kind": "filter", "dcId": "12101", "dcName": "Shared", "resolution": "collision", "candidates": ["20100","20101"] }
      ],

      /* stage 2: asset-ref rewrites inside aqlFunction(...) */
      "aqlReplacements": [
        { "kind": "key",      "dcValue": "CMDB-21171", "cloudValue": "CMDB-14544", "function": "aqlFunction" },
        { "kind": "objectId", "dcValue": "14032",    "cloudValue": "27118",    "function": "aqlFunction" }
      ],
      "aqlUnresolved": [ "key:CMDB-99999", "objectId:555" ],

      /* stage 3: sanitizer changes */
      "sanitizerChanges": [
        { "kind": "field_rename",  "from": "Customer Request Type", "to": "Request Type" },
        { "kind": "op_upper",      "from": "not in",                "to": "NOT IN" },
        { "kind": "quote_in_list", "from": "Test",                  "to": "\"Test\"" }
      ],

      "error": null,
      "updatedAt": "ISO8601"
    }
  }
}
```

**Filter statuses:**

- `pending` — JQL changed; ready to be PUT. Execute phase targets these.
- `completed` — PUT succeeded.
- `failed` — PUT returned a non-recoverable error; see `error` and `lastStepError`.
- `skipped` — had refs but none resolved (no_change after rewrites) or
  `jql_changed_since_plan` (when `--verify-name` caught a mid-run edit).
- `no_change` — filter had no refs and no sanitizer-actionable JQL.

**Ref resolutions:**

- `ok` — DC identifier resolved to a Cloud identifier via name match.
- `dc_deleted` — DC returned 404 (or no dc-dump entry); id left intact.
- `cloud_not_found` — DC name known but no Cloud filter/asset with that name.
- `collision` — >1 Cloud candidate with the same name; `candidates[]`
  listed for manual review.

**Execution phases** (state machine cursor — persisted after every step):

- `idle` — entry exists but Phase 2 hasn't touched it.
- `owner_swapping` → `owner_swapped` — step 2 in progress / done.
- `updating` → `updated` — step 3 in progress / done.
- `owner_restoring` → `done` | `failed` — step 4 in progress / terminal.

---

## CLI reference

Run `node main/rewrite_filter_refs.js --help` for the in-tool listing. All
flags are optional unless noted.

### Phase control

| Flag | Purpose |
|---|---|
| `--plan-only` | Phase 1 only (write plan, skip writes). |
| `--execute-only` / `--resume` | Phase 2 only (load latest plan). |
| `--dry-run` | Preview. Phase 2 logs before/after but issues no PUTs. |
| `--plan-file <path>` | Explicit `master_<runId>.json` to resume from. |
| `--save-dry-run` | Persist plan even in dry-run. |

### Scope

| Flag | Purpose |
|---|---|
| `--limit <n>` | Cap Cloud filters scanned in Phase 1. |
| `--id-file <path>` | Newline-separated Cloud filter IDs. |
| `--name-prefix <s>` | Case-insensitive name prefix filter. |
| `--skip-not-owned` | Skip filters not owned by the calling account. |
| `--retry-failed` | Include `failed` entries in Phase 2. |

### Owner-swap (v2)

| Flag | Default | Purpose |
|---|---|---|
| `--no-owner-swap` | off (swap on) | Skip steps 2 + 4. |
| `--swap-only-on-403` | off | Try PUT first; swap only after a 403, then retry. |

### Permissions merge (v2)

| Flag | Default | Purpose |
|---|---|---|
| `--no-share-org-admins` | off (merge on) | Don't add `org-admins` to share+edit. |
| `--org-admins-group <name>` | `org-admins` | Override group name (for tenants that renamed it). |

### JQL sanitizer (v2)

| Flag | Default | Purpose |
|---|---|---|
| `--no-sanitize` | off (sanitize on) | Disable the whole sanitizer pass. |
| `--no-uppercase-ops` | off | Leave operators as-is. |
| `--no-quote-in-lists` | off | Leave bare IN-list tokens alone. |
| `--rename-fields <path>` | — | CSV (`from,to`) or JSON (`{"From":"To"}`) merged with defaults. |

### Post-mortem mitigations (v2.1, all OFF by default — opt in)

| Flag | Default | Purpose |
|---|---|---|
| `--cf-map <path>` | — | CSV (`dc_id,cloud_id`) or JSON `{dc:cloud}` map of custom-field IDs. Rewrites `cf[NNN]` in JQL. |
| `--strip-broken-functions` | off | Remove DC-only / ScriptRunner JQL functions (`subtask`, `parent`, `subtasksOf`, `hasSubtasks`, `versionsAfterDate`, `issuesWhereEpicIn`, `linkedIssuesInProject`, `linkedIssuesOf`, `epicsOf`, `issueFunction`, …) from JQL. **Also recognises the JQL Tricks `issueFunction <op> <fn>(...)` field-form** where `issueFunction` is the FIELD, not the function (Cloud rejects this with `Field 'issueFunction' does not exist or you do not have permission to view it.`). DESTRUCTIVE — every removal is logged to `stripped_functions_<runId>.csv`. The default broken-function list is cross-checked against the [Cloud JQL function reference](https://support.atlassian.com/jira-software-cloud/docs/jql-functions/) so Cloud-valid names (`parentEpic`, `cascadeOption`, `membersOf`, `currentUser`, `now`, `parentEpic`, `componentsLeadByUser`, the `endOf*`/`startOf*` helpers, `votedIssues`/`watchedIssues`, etc.) are never stripped. |
| `--broken-functions <csv>` | — | Override the function list, e.g. `"subtask,parent"` (lowercase, comma-separated). The `issueFunction`-as-field path runs **regardless** of this override (the override is about function names, not field names). |
| `--validate-projects` | off | Pre-load Cloud project keys/names; record any project references in JQL not found on Cloud. |
| `--skip-missing-projects` | off (implies `--validate-projects`) | If a filter references a missing project in equality form (or all entries of an IN list are missing), mark it `skipped:project_missing`. |
| `--strip-missing-projects` | off (implies `--validate-projects`) | Drop missing tokens from `IN (...)` lists; if a list becomes empty, mark filter unfixable. |

> **Why a strip is needed.** Per Adaptavist's [migration troubleshooting](https://docs.adaptavist.com/sr4js/9.13.0/scriptrunner-migration/migrating-to-cloud/troubleshoot-scriptrunner-migration), ScriptRunner JQL functions like `issueFunction`, `subtasksOf`, `linkedIssuesOf` exist on Cloud **only inside the Enhanced Search app**, never in the native Jira JQL engine that backs filter PUTs. JCMA tries to migrate ScriptRunner-flavoured filters to Enhanced Search but skips filters whose owner can't access Cloud, that haven't been used in 60 days, or that contain nested ScriptRunner functions. For those, our strip is the correct fallback — better a working filter without the DC-only clauses than a 400 on PUT.

### Asset rewrites (v2)

| Flag | Default | Purpose |
|---|---|---|
| `--no-asset-rewrite` | off (on) | Skip aqlFunction rewriting entirely. |
| `--asset-plan-glob <p>` | `../sync_asset_ticket_associations/logs/plan_*.json` | DC→Cloud asset map source. |
| `--asset-live-fallback` | off | On miss, query Cloud Assets by name (needs `CLOUD_WORKSPACE_ID`). |

### Priority name rewrites (v2.3, default ON)

| Flag | Default | Purpose |
|---|---|---|
| `--no-priority-rewrite` | off (on) | Skip the priority value rewrite pass. By default we GET both `/priority` endpoints, pair by id, and rewrite `priority = ...` clauses where Cloud's current name differs from DC's. |
| `--priority-map <path>` | — | Manual DC-name → Cloud-name override. CSV (`dc_name,cloud_name`) or JSON (`{"DC":"Cloud"}`). Merged on top of the auto-built map; manual wins on conflict. |
| `--priority-map-cache <p>` | `logs/priority_map_cache_<runId>.json` | Where to dump the merged DC→Cloud name map for inspection. |

### Direct Asset-field refs + ORDER BY clean + auto cf-map (v2.2, default ON)

| Flag | Default | Purpose |
|---|---|---|
| `--no-asset-field-rewrite` | off (on) | Skip rewriting direct asset-field refs outside `aqlFunction` (e.g. `"Development Team" = 14032` → `"Development Team" = "Platform Squad"`). |
| `--no-order-by-clean` | off (on) | Skip stripping `ORDER BY` clauses on Asset fields (Cloud does not support sorting on Asset fields). |
| `--no-traffic-light-label` | off (on) | Skip appending `.Label` to value-comparison clauses on Forge traffic-light fields (e.g. Team Priority). |
| `--no-auto-cf-map` | off (on) | Skip live `/field` fetch from DC + Cloud. Without it, only the manual `--cf-map` (if provided) is used. |
| `--auto-cf-map-cache <p>` | `logs/field_map_cache_<runId>.json` | Path to write the auto-built field-map JSON for later reuse. |

### Other

| Flag | Purpose |
|---|---|
| `--concurrency <n>` | Parallel PUTs in Phase 2 (default 5). |
| `--dc-dump <file>` | Preload DC filter-id → name map (JSON or CSV). |
| `--verify-name` | Re-GET each filter just before PUT; skip if JQL changed (compares vs `originalJql`). |
| `--avoid-overwrite` (v2.2) | Re-GET each filter; compare Cloud's live JQL against `expectedLiveJql` (set by `main/refresh_plan.js`) or `originalJql`. On mismatch, mark `skipped:externally_modified` to preserve manual edits. Adds one GET per filter. |
| `--collision-resolve <csv>` | **Wiring TODO**; flag is parsed + logged but overrides aren't applied yet. |
| `--help` | Usage. |

---

## Environment variables

Loaded from `.env` via `dotenv` in
`main/rewrite_filter_refs.js`. Required keys are not auto-generated —
copy `.env.example` and fill in.

| Var | Required | Notes |
|---|---|---|
| `CLOUD_BASE_URL` | ✔ | e.g. `https://your-site.atlassian.net` |
| `CLOUD_API_TOKEN` | ✔ | **Base64** of `email:api_token` (not the raw token). Create with `echo -n "you@example.com:ATATT..." \| base64`. See [Manage API tokens for your Atlassian account](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/). |
| `DC_BASE_URL` | optional | Needed for DC filter name lookup if `--dc-dump` absent. |
| `DC_USERNAME` | optional | DC admin username. |
| `DC_PASSWORD` | optional | DC admin password. |
| `CLOUD_WORKSPACE_ID` | optional | Assets workspace UUID. Required only with `--asset-live-fallback`. Find via `GET /rest/servicedeskapi/assets/workspace`. Reuse the same value as `sync_asset_ticket_associations/.env` (commonly `00000010-0000-4000-8000-000000000010` in this org). |

---

## Setup

```bash
cd jira/jira-data/rewrite-filter-refs
cp .env.example .env
# ...edit .env...
npm install        # dotenv only
npm test           # 75 unit + integration tests
```

Node version: tested on modern Node (uses `node:test` built-in, native
`https`, `readline`). Anything 18+ should work; 20+ recommended.

---

## Recommended run order

Run with care — Phase 2 does real PUTs. Treat your first live run as an
experiment on a small scope.

```bash
# 1. Offline plan-only on a tiny scope
node main/rewrite_filter_refs.js --plan-only --limit 5
# Inspect:
#   logs/plan_<runId>.json        (full state + all rewrites)
#   logs/unresolved_refs_*.csv    (what we couldn't resolve)
#   logs/collisions_*.csv         (DC name matched >1 Cloud)

# 2. Dry-run Phase 2 against that plan — zero writes, logs before/after
node main/rewrite_filter_refs.js --execute-only --dry-run

# 3. Hand-picked single-filter smoke
echo 10234 > /tmp/one.txt
node main/rewrite_filter_refs.js --plan-only --id-file /tmp/one.txt
# review logs/plan_<runId>.json — is the rewrittenJql what you want?
node main/rewrite_filter_refs.js --execute-only

# 4. Verify in Cloud: open the filter in the UI, confirm JQL looks right
#    and the issue count is what you expect.

# 5. Full run (plan + execute, modest concurrency)
node main/rewrite_filter_refs.js --concurrency 5

# 6. Resume after SIGINT
node main/rewrite_filter_refs.js --resume

# 7. Revisit failed entries specifically
node main/rewrite_filter_refs.js --resume --retry-failed
```

---

## Outputs (in `logs/`)

- `rewrite_<ts>.log` — full transcript (stdout mirrored to file).
- `master_<runId>.json` — small index; points at plan file, holds run-level stats.
- `plan_<runId>.json` — per-filter state (see schema above). **Safe to
  inspect and diff.** The execute phase only reads this file.
- `unresolved_refs_<runId>.csv` — every ref (filter or asset) whose
  resolution ≠ `ok`.
- `collisions_<runId>.csv` — subset with `resolution === "collision"`.
- `rewrites_<runId>.csv` (Phase 2) — per-filter before/after JQL + final status.
- `orphaned_owner_swaps_<runId>.csv` — filters stuck with
  `ownerSwapped=true, ownerRestored=false`. Rerun with `--resume` to
  retry just the restore.
- `asset_collisions_<runId>.csv` — DC asset keys that mapped to multiple
  Cloud keys across sibling plan files.
- `asset_field_rewrites_<runId>.csv` (v2.2) — one row per direct asset-field
  rewrite (ARI, key, or numeric → object name) plus rows for any
  unresolved values.
- `order_by_stripped_<runId>.csv` (v2.2) — one row per ORDER BY entry
  dropped because the field is an Asset custom field.
- `traffic_light_label_appends_<runId>.csv` (v2.2) — one row per
  value-comparison clause where the rewriter appended `.Label` to a
  Forge traffic-light field.
- `field_map_cache_<runId>.json` (v2.2) — auto-built DC→Cloud custom-field
  map, collision list, and asset-field name set.
- `priority_rewrites_<runId>.csv` (v2.3) — one row per priority value
  rewrite (DC name → Cloud name), with the form (`=`, `!=`, `IN`, `NOT IN`)
  and the filter's before/after JQL.
- `priority_map_cache_<runId>.json` (v2.3) — merged DC→Cloud priority
  name map (auto-build + manual override), with collisions, skipped
  priorities, and pairing stats.

---

## Testing

### Current state

**75 tests pass** via `npm test` (runs `node --test src/*.test.js`):

| Suite | Tests | What it covers |
|---|---|---|
| `jqlRewriter.test.js` | 24 | filter-ref rewrites (equality/IN/alias) + aqlFunction scanner with escape round-tripping |
| `aqlRewriter.test.js` | 13 | Key / objectId AQL fragment rewrites, case-insensitive, escape handling |
| `jqlSanitizer.test.js` | 18 | field rename, operator uppercasing, IN-list quoting, screenshot example |
| `permissions.test.js` | 8 | merge idempotency, existing entries preserved, stripForWrite |
| `filterProcessor.test.js` | 12 | 6-step state machine integration via mocked Cloud client |

### Integration tests (the thing that actually caught two real bugs)

`src/filterProcessor.test.js` constructs a FilterProcessor with plain-JS
mocks (no external libraries) and calls `_executeOne()` directly,
asserting:

- **Test 1** — `shareOrgAdmins=false → PUT body omits
  sharePermissions/editPermissions entirely`. Caught the bug where we
  were passing `[]` which would have wiped all shares.
- **Test 5** — `resume with jqlUpdated=true → no PUT is issued, restore
  still runs`. Caught the redundant-PUT bug on resume.
- Tests 6-12 cover: happy path; already-owner; update-fail-then-restore;
  update-fail-and-restore-fail (orphaned); owner-swap-itself-fails;
  `--swap-only-on-403`; v1-plan live fetch.

### What's NOT tested

Integration test gaps worth closing:

1. **`filterProcessor.buildPlan()`** — the 4-pass build pipeline is only
   tested indirectly via its underlying pure modules. An integration
   test with a mocked `searchAllFilters` would verify that:
   - Filters with no refs end up `no_change`.
   - Filters with mixed `ok`/`collision`/`dc_deleted` refs get partial
     rewrites.
   - The interaction between filter-ref, asset-ref, and sanitizer
     changes status correctly (`pending` vs `skipped`).
2. **`assetMapLoader`** — smoke-tested against real data in this repo
   (1.18M issues, 3,508 mappings) but no automated regression test.
   Could add a fixture with synthetic plan files.
3. **`planManager` v1/v2 round-trip** — backward-compat is claimed in
   docs but not pinned by a test.
4. **`cloudJiraClient`** — retry/backoff is production-critical and
   untested. A mock-HTTP server test (e.g. spinning a local HTTP server
   that returns 429 / 500 / 200) would give real confidence.
5. **`reportWriter`** — CSV escaping (quotes, commas, newlines in
   values) is untested. Low risk but easy to cover.
6. **`main/rewrite_filter_refs.js`** — argv parsing, env validation,
   and startup wiring are untested. End-to-end smoke could be achieved
   with a CLI harness.

### How to add tests

1. **Pure modules** (jqlRewriter, aqlRewriter, jqlSanitizer,
   permissions): add a case to the existing `*.test.js`. They use the
   Node built-in test runner (`node:test`) — no framework required.

2. **Integration (via mocked clients)**: follow the pattern in
   `filterProcessor.test.js`:
   - `makeCloudClient({updateFilterImpl, setFilterOwnerImpl, ...})`
     returns a mock with `calls` recorded.
   - `makePlanManager(initialEntry)` returns a minimal PlanManager.
   - Build the processor with `makeProcessor(client, pm, options)`.
   - Call `_executeOne()` and assert on `client.calls.*` and the
     resulting plan entry.

3. **The "reverse test" discipline**: for any bug you find, before
   pushing the fix, *temporarily revert the fix* and confirm the new
   test fails. Then put the fix back and confirm green. This is how we
   validated the two bugs fixed after initial review — see the git
   history of `filterProcessor.js`.

4. **End-to-end against a sandbox**: manual only. See the verification
   plan below.

### Verification plan (end-to-end)

Once `.env` is populated against a sandbox Cloud (not production):

1. **Unit/integration**: `npm test` — must be all green before proceeding.
2. **Offline plan-only, tiny scope**:
   ```
   node main/rewrite_filter_refs.js --plan-only --limit 5
   ```
   Confirm `plan_<runId>.json` contains the expected entries;
   `aqlReplacements` and `sanitizerChanges` are populated where
   applicable.
3. **Dry-run execute**:
   ```
   node main/rewrite_filter_refs.js --execute-only --dry-run
   ```
   Logs planned owner swaps + permission merges + JQL diffs. Zero PUTs.
4. **Single-filter smoke on a test filter you don't own**:
   - Verify step 2 swaps owner → current user (Cloud UI should briefly
     show that).
   - Verify step 3 updates JQL + adds `org-admins` to both permission
     arrays.
   - Verify step 4 restores original owner.
5. **SIGINT resume**:
   - Start a larger run, Ctrl-C it mid-batch.
   - `node main/rewrite_filter_refs.js --resume`
   - Verify it picks up only the remaining `pending` (or in-flight)
     entries.
6. **Idempotency**: re-run the same command with no new work;
   expect `no_change` for all entries already processed.
7. **Customer Request Type sanitizer**: pick a filter matching the
   screenshot-style error. Verify the rewritten JQL no longer triggers
   the "Field 'Customer Request Type' does not exist" error in the
   Cloud filter UI.
8. **Asset rewrite**: pick a filter containing `aqlFunction("Key IN
   (...)")` with DC keys. Verify Cloud keys replace them and the
   filter's issue count matches expectation.
9. **Collision + deleted cases**: pre-seed a filter referencing a name
   with multiple Cloud filters (collision) and another referencing a
   non-existent DC id (deleted). Verify CSV reports, no PUT for those
   refs.
10. **Permission-denied recovery**: run as a non-admin against a filter
    you don't own, without `--no-owner-swap`. Expect the swap to make
    the PUT succeed. Without owner-swap, expect `failed:
    permission_denied:` in the CSV.

---

## Edge cases and behavior notes

- **DC filter deleted** — `resolution: dc_deleted`; id left intact. If
  **all** refs are `dc_deleted`/`not_found`/`collision`, filter status
  = `skipped` (no PUT). Partial (some `ok`) → `pending`, rewritten only
  for the `ok` ones; untouched ids reported.
- **Cloud name collision** — no rewrite for that ref; `candidates[]`
  captures all Cloud filter IDs with the same name.
- **Non-English names** — `encodeURIComponent` for URL params, Unicode
  NFC + `.trim()` + `.toLowerCase()` for map keys.
- **PUT 403** — if owner-swap enabled, we've already taken ownership so
  this is rare. If it still 403s, error prefix `permission_denied:`.
- **PUT 400** — Cloud's JQL parser rejected the rewritten string. Look
  at `rewrites_*.csv` to see the exact before/after and tighten
  `jqlSanitizer` if the sanitizer produced it.
- **429 rate limiting** — client retries up to 3x with `Retry-After`. If
  a batch saw any 429s, the processor pauses 10–60s before the next
  batch.
- **Interrupted run** — SIGINT/SIGTERM persists plan. Re-run with
  `--resume` or `--execute-only` to continue.
- **Self-referential filter** — rewriting a filter's own old DC id to
  its own new Cloud id is a no-op for JQL semantics; no special
  handling.
- **Idempotent** — second run finds no actionable refs (rewrites were
  applied; sanitizer output is stable; org-admins merge is idempotent).

---

## Known issues & tradeoffs (accepted)

1. **3× API traffic in Phase 2.** Each filter: GET + PUT/owner + PUT + PUT/owner.
   For ~1000 filters that's ~4000 Cloud calls. Mitigation:
   `--swap-only-on-403` halves happy-path traffic.
2. **Failed owner-restore leaves filter owned by migration user.**
   Emits `orphaned_owner_swaps_<runId>.csv` + loud summary alert.
   `--resume` retries only the restore (step 4 is idempotent — a no-op
   if already restored; step 3 is skipped if `jqlUpdated=true`).
3. **Share permissions replaced wholesale by PUT.** We always pass the
   full merged list, never `[]`. This is pinned by the `shareOrgAdmins=false`
   test in `filterProcessor.test.js`.
4. **Sanitizer false positives.** The IN-list quoting rule is the
   riskiest (a crafted token like `EMPTY` shouldn't be quoted — we keep
   a reserved-word whitelist). Every sanitizer transform is logged in
   `sanitizerChanges[]` for pre-execute review.
5. **Asset map staleness.** Preload is a point-in-time snapshot of the
   sibling's migration. If Cloud objects were later renamed, the map is
   stale. `--asset-live-fallback` fixes this at the cost of Cloud API
   traffic. Off by default.
6. **`dcObjectIdToCloudObjectId` not populated from sibling plans.** The
   sibling script doesn't record DC numeric objectIds. If your filters
   reference `objectId = 14032`, you'll need a different dump source or
   to add a resolver that walks DC Insight (if your DC has the REST
   plugin exposing `/rest/insight/1.0/object/{id}`).
7. **Self-contained copy of `cloudAssetsClient.js`.** If the sibling
   improves it, this copy doesn't automatically benefit. Manual re-sync
   if needed.
8. **`--collision-resolve <csv>` wiring TODO.** Flag is parsed +
   logged but the override logic is not wired into
   `FilterProcessor.buildPlan()` yet. Easiest spot: just before the
   `resolveCloudIdByName(name)` call — if an override for that dcId
   exists, use its cloudId directly.
9. **DC numeric-to-Cloud-numeric filter id mapping** relies on having
   DC connectivity OR a `--dc-dump` JSON/CSV. Without both, filter-ref
   resolution degrades to `dc_deleted` for everything.

---

## Where to start if you're picking this up cold

You probably want to do one of four things:

1. **Run it.** See "Setup" and "Recommended run order" above.
2. **Extend the JQL rewriter** (new shapes, different field types). Add
   a test in `src/jqlRewriter.test.js` (for filter refs / aqlFunction
   scanner) or `src/jqlSanitizer.test.js` (for JQL cleanup) first, then
   make it pass. Keep I/O out of the pure modules.
3. **Extend the asset rewriter** (new AQL fragments, new identifier
   forms). Add a test in `src/aqlRewriter.test.js`, then make it pass.
4. **Harden the integration layer.** Most valuable: add tests for
   `filterProcessor.buildPlan()` with a mocked `searchAllFilters`, and
   for `cloudJiraClient.makeRequest()` against a local HTTP test
   server. See "Testing › What's NOT tested".

The git history is a trustworthy source of intent — every commit after
`final an earlier engagement scripts and improvements` (commit `6b3eac6`) has a
message describing why the change was made.

---

## References

### Atlassian API docs

- [Jira Cloud Filters API (v3)](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-filters/) — `GET /filter/search`, `GET /filter/{id}`, `PUT /filter/{id}`, `PUT /filter/{id}/owner`.
- [Jira Cloud Filter Sharing API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-filter-sharing/) — permission add/list/delete; we use the inline array on `PUT /filter/{id}` instead.
- [Jira Cloud Groups API — groups/picker](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-groups/) — for `pickGroup`.
- [Jira Cloud Myself API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/) — `GET /myself` → accountId.
- [Assets Cloud REST API](https://developer.atlassian.com/cloud/assets/rest/) — object/aql, object/{id}.
- [AQL (Assets Query Language) syntax](https://support.atlassian.com/assets/docs/use-assets-query-language-aql/).
- [Assets JQL functions (`aqlFunction`)](https://support.atlassian.com/jira-service-management-cloud/docs/assets-jql-functions/) — the only JQL wrapper for Assets on Cloud.
- [Jira DC Filter API v11003](https://developer.atlassian.com/server/jira/platform/rest/v11003/api-group-filter/) — `GET /api/2/filter/{id}` used for DC name lookups.
- [Migrating JSM Assets from Sandbox to Production (KB)](https://support.atlassian.com/jira/kb/alternative-solutions-for-migrating-jsm-cloud-assets-schema-from-sandbox-to/) — explains that Object Keys are regenerated on import.
- [Manage API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/).

### JSM field rename context

- [Categorize customer requests into request types (Cloud)](https://support.atlassian.com/jira-service-management-cloud/docs/categorize-customer-requests-into-request-types/) — Cloud uses "Request Type".
- DC used "Customer Request Type" for the same concept (see DC Service Desk docs prior to unification). Community confirmation: many JCMA migrations leave the old name in place in filter JQL, producing the "Field 'Customer Request Type' does not exist" error we fix with the sanitizer.

### Sibling scripts (in this repo)

- `jira/jira-data/sync_asset_ticket_associations/` — source of the DC→Cloud
  asset name pairs we preload. Also the canonical reference for
  `cloudAssetsClient.js`.
- `jira/jira-data/add-to-security-levels/` — pattern source for the HTTP
  client retry/backoff and CLI argv-parsing convention.
- `jira/jira-data/sync_security_levels/` — pattern source for
  `PlanManager` (master/plan two-file, streamed writer, resume).

### Plan documents

- `./data` — v1
  design doc (filter-ID rewrites only).
- `./data`
  — v2 extension plan (this README is the v2 delivery).

### Handoff notes for the next agent

- Read the v2 plan first if you need intent and tradeoff context.
- Then read `src/filterProcessor.js :: _executeOne` — that's the heart.
- Then read `src/filterProcessor.test.js` — it's the clearest executable
  spec of what the state machine must do.
- `npm test` before you change anything. If it's not green, stop and
  figure out why before touching anything else.
