# Jira Cloud Automation Migrator (Node.js)

A comprehensive Node.js tool for migrating and managing Jira Cloud automation rules between instances.

> ### Non-interactive cloud→cloud pipeline (the path actually used)
> The interactive modes are flaky; the reliable flow is the standalone scripts:
> 1. `export_all.js` — full export of source rules (summary + per-rule body).
> 2. `gen_mappings.js` — cache source→target id maps (`OUT=mappings.json`).
> 3. **`ensure_actor_access.js`** — add the rule actor to each target project's
>    **Service Desk Team** (agent) role. REQUIRED or JSM rules fail to create with
>    `400 component.missing.permissions.actor`. Being site-admin is NOT enough and
>    `/mypermissions` lies (reports Y) — the engine needs real agent membership.
> 4. **`import_clean.js`** — import the cleanly-mappable rules. Set
>    **`ACTOR_OVERRIDE=<target accountId>`** so rules run as a known-good account
>    (the source actor is often an app account with no perms on the target). Honors
>    `PLAN=1` for a dry preview. Auto-discovers + remaps the Assets workspace id.
>
> ### Reconcile-target mode (fix + enable IN PLACE — no import) — `reconcile_target.js`
> For when the target ALREADY has the rules (e.g. JCMA-migrated) and you just need to
> correct their field references and enable them — without re-creating anything:
> 1. Reads every rule already on the **target** (full bodies).
> 2. Reads the source-of-truth rules from a **Datacenter** instance (configurable URL,
>    `DC_RULES_BASE` — e.g. `https://servicedesk.example.com`) via the cb-automation REST
>    API → desired **enabled/disabled state** per rule + which rules are in scope.
> 3. Builds a **DC-authoritative** field map (`DC_FIELDS_BASE` field id→name → target
>    Cloud field by name → Cloud id) and rewrites field refs in smart values/components.
>    Default-safe: only remaps DC ids that are BROKEN on target; `AGGRESSIVE=1` also
>    remaps id-collisions (review the diff).
> 4. PUTs the corrected rule in place (`ruleService.updateRule`) and sets its state to
>    match DC. **Surplus** target rules (no matching DC rule by name) are NEVER touched.
>
> `DRY=1` previews everything. Env: U/T, TGT_SITE, TGT_CLOUD, DC_FIELDS_BASE+creds,
> DC_RULES_BASE+creds (defaults to DC_FIELDS), NO_SET_STATE=1 to fix fields only.
> Verified DRY on the dry-run tenant: 0 false field-corrections (rules already correct), 8 state
> reconciliations, 21 surplus untouched.

> See each script's header for env vars. Lessons learned on a sandbox tenant
> (2026-06-11): the actor-permission + Service-Desk-Team-role requirement was the
> single biggest gotcha; `import_clean.js` dedupes by rule NAME, so per-project
> copies of same-named rules are skipped once the name exists in the target.

## Features

- **7 Migration Modes** for different scenarios
- **Email Action Safety** - Automatically detects and disables rules with email actions
- **ID Mapping** - Automatically fixes project and issue type IDs between instances
- **Interactive CLI** - User-friendly prompts and confirmations
- **Detailed Logging** - Evidence logging for audit trails
- **Modular Architecture** - Clean, maintainable codebase

## Installation

```bash
npm install
```

## Prerequisites

- Node.js >= 14.0.0
- Jira Cloud API tokens for source/target instances
- Jira Cloud IDs for your instances

### How to Get Your Cloud ID

You can find your Cloud ID by:
1. Go to https://YOUR_DOMAIN.atlassian.net/_edge/tenant_info
2. Look for the `cloudId` field in the JSON response

## Usage

The tool provides 8 different modes for various migration scenarios:

### 1. Blanket Mode

Enable all disabled automation rules in a Jira instance (with email action safety checks).

```bash
node index.js blanket \
  --username user@example.com \
  --token YOUR_API_TOKEN \
  --cloud-id YOUR_CLOUD_ID
```

### 2. Consolidation Dual Source Mode

Compare target instance with 2 source instances (sandbox + production) and enable missing rules.

```bash
node index.js consolidation-dual-source \
  --sandbox-username sandbox@example.com \
  --sandbox-token SANDBOX_TOKEN \
  --sandbox-cloud-id SANDBOX_CLOUD_ID \
  --prod-username prod@example.com \
  --prod-token PROD_TOKEN \
  --prod-cloud-id PROD_CLOUD_ID \
  --target-username target@example.com \
  --target-token TARGET_TOKEN \
  --target-cloud-id TARGET_CLOUD_ID
```

### 3. Consolidation Sandbox Mode

Migrate automation rules from sandbox to production instance.

```bash
node index.js consolidation-sandbox \
  --sandbox-username sandbox@example.com \
  --sandbox-token SANDBOX_TOKEN \
  --sandbox-cloud-id SANDBOX_CLOUD_ID \
  --prod-username prod@example.com \
  --prod-token PROD_TOKEN \
  --prod-cloud-id PROD_CLOUD_ID
```

### 4. Consolidation Prod Mode

Migrate automation rules from source to target instance.

```bash
node index.js consolidation-prod \
  --source-username source@example.com \
  --source-token SOURCE_TOKEN \
  --source-cloud-id SOURCE_CLOUD_ID \
  --target-username target@example.com \
  --target-token TARGET_TOKEN \
  --target-cloud-id TARGET_CLOUD_ID
```

### 5. Generate JSON Mode

Export automation rules to a JSON file for selected projects.

```bash
node index.js generate-json \
  --username user@example.com \
  --token YOUR_API_TOKEN \
  --cloud-id YOUR_CLOUD_ID
```

**Output:** `automation_rules_DOMAIN_YYYY-MM-DD.json`

### 6. Fix JSON Mode

Fix project and issue type IDs in an automation rules JSON file. Supports two modes:

#### Cloud-to-Cloud Mode (API-based)
Automatically generates mappings by querying both source and target Cloud instances:

```bash
node index.js fix-json \
  --source-username source@example.com \
  --source-token SOURCE_TOKEN \
  --source-site-url source-domain.atlassian.net \
  --target-username target@example.com \
  --target-token TARGET_TOKEN \
  --target-site-url target-domain.atlassian.net
```

#### Data Center-to-Cloud Mode (Mapping file-based)
Uses a pre-generated mapping file from the Data Center extraction script:

```bash
node index.js fix-json \
  --mapping-file /path/to/datacenter_cloud_mapping.json
```

**Input:** Interactive prompt for automation rules JSON file path  
**Output:** `automation_rules_fixed_cloud_YYYY-MM-DD.json`

> **Note:** For Data Center migrations, see the [Data Center Migration Workflow](#data-center-migration-workflow) section below.

### 7. Data Center to Cloud Mode (NEW - Integrated Workflow)

**THE RECOMMENDED WAY** for Data Center to Cloud migrations. This mode auto-populates Cloud IDs and fixes automation rules in a single integrated workflow.

```bash
node index.js datacenter-to-cloud \
  --mapping-file /path/to/datacenter_cloud_mapping.json \
  --cloud-username cloud@example.com \
  --cloud-token CLOUD_API_TOKEN \
  --cloud-site-url your-domain.atlassian.net
```

**What it does:**
1. **Phase 1:** Loads your Data Center mapping file (generated by bash script)
2. **Phase 2:** Auto-populates Cloud IDs by querying the Cloud API:
   - Projects (matched by key)
   - Issue Types (matched by name)
   - Custom Fields (matched by name + field type)
   - Statuses (matched by name + category)
   - Users (matched by email)
   - Resolutions, Priorities (if present)
3. **Phase 3:** Fixes automation rules using the populated mappings

**Inputs:**
- `datacenter_cloud_mapping.json` with null Cloud IDs (from bash script)
- `automation.json` (exported from Data Center UI)

**Outputs:**
- `datacenter_cloud_mapping_populated_YYYY-MM-DD.json` (with Cloud IDs)
- `automation_rules_fixed_cloud_YYYY-MM-DD.json` (ready for Cloud import)

**Benefits:**
- ✅ No manual ID lookup required
- ✅ Automatic matching by name/key/email
- ✅ One command does everything
- ✅ Clear phase-by-phase progress
- ✅ Saves both updated mapping and fixed rules

### 8. Import JSON Mode

Complete end-to-end migration: export from source, fix IDs, and import to target.

```bash
node index.js import-json \
  --source-username source@example.com \
  --source-token SOURCE_TOKEN \
  --source-cloud-id SOURCE_CLOUD_ID \
  --source-domain source-domain \
  --target-username target@example.com \
  --target-token TARGET_TOKEN \
  --target-cloud-id TARGET_CLOUD_ID \
  --target-domain target-domain
```

## Project Structure

```
automation-service/
├── index.js                          # Main CLI entry point
├── package.json                      # Dependencies and scripts
├── README.md                         # This file
├── src/
│   ├── api/
│   │   └── jiraClient.js            # HTTP client for Jira API
│   ├── services/
│   │   ├── projectService.js        # Project fetching and filtering
│   │   ├── ruleService.js           # Automation rule CRUD operations
│   │   └── mappingService.js        # ID mapping generation and fixing
│   ├── modes/
│   │   ├── blanketMode.js           # Blanket mode implementation
│   │   ├── consolidationModes.js    # All 3 consolidation modes
│   │   └── jsonModes.js             # All 3 JSON modes
│   └── utils/
│       ├── logger.js                # Winston logging configuration
│       └── input.js                 # Readline helpers for user input
└── logs/
    └── evidence.log                 # Detailed evidence log (auto-created)
```

## Key Features Explained

### Email Action Safety

The tool automatically detects automation rules that contain email actions and:
- Skips enabling them in blanket mode
- Imports them in DISABLED state
- Logs warnings for visibility

This prevents accidental spam when migrating rules.

### ID Mapping

When migrating between instances, project IDs and issue type IDs are different. The tool:
1. Fetches all projects and issue types from both instances
2. Matches them by key/name
3. Recursively updates all IDs in automation rules
4. Handles missing mappings gracefully

### State Validation

The tool validates automation rule states (ENABLED/DISABLED/UNKNOWN) and logs warnings for unexpected states.

### Evidence Logging

All operations are logged to `logs/evidence.log` with detailed information for audit trails:
- Timestamps
- Mode executed
- Parameters used
- Success/failure counts
- Rule names and IDs

## Data Center Migration Workflow

**IMPORTANT:** Jira Data Center does NOT have the Automation REST API that this tool uses. Therefore, Data Center-to-Cloud migration requires a **hybrid approach** using both bash scripts and this Node.js tool.

### Prerequisites for Data Center Migration

1. Access to Jira Data Center instance with admin credentials
2. Jira Cloud instance with API token
3. The `get_datacenter` bash scripts (located in `../get_datacenter/main/`)
4. `jq` command-line JSON processor installed

### Complete Data Center → Cloud Migration Steps

#### Step 1: Manual Export from Data Center UI

Automation rules must be **manually exported** from Data Center:

1. Log into your Jira Data Center instance
2. Navigate to **Project Settings → Automation** (or **Global Automation**)
3. Select the rules you want to migrate
4. Click **Export** and save as `automation.json`

> **Why manual?** Data Center doesn't have the Automation REST API endpoints that Cloud uses.

#### Step 2: Generate Mapping File (Bash Script)

Run the mapping generator script to extract all entity IDs and fetch their details from Data Center:

```bash
cd ../get_datacenter/main
./generate_automation_mapping.sh
```

**What it does:**
- Reads your `automation.json` file
- Extracts all entity IDs:
  - Project IDs
  - Custom Field IDs
  - Issue Type IDs  
  - Status IDs
  - User Account IDs
- Queries Data Center APIs to get entity details (names, keys, emails)
- Generates `datacenter_cloud_mapping.json` with blank Cloud ID fields

**Output:** `datacenter_cloud_mapping.json`

Example structure:
```json
{
  "metadata": { "generated": "2025-11-06 14:30:00", ... },
  "projects": [
    {
      "datacenter_id": "10000",
      "key": "PROJ",
      "name": "My Project",
      "cloud_id": null  // ← AUTO-POPULATED by datacenter-to-cloud mode
    }
  ],
  "custom_fields": [ ... ],
  "issue_types": [ ... ],
  "statuses": [ ... ],
  "users": [ ... ]
}
```

#### Step 3: Auto-Populate Cloud IDs & Fix Rules (NEW - Integrated Mode)

**RECOMMENDED:** Use the new `datacenter-to-cloud` mode which does everything automatically:

```bash
node index.js datacenter-to-cloud \
  --mapping-file datacenter_cloud_mapping.json \
  --cloud-username cloud@example.com \
  --cloud-token CLOUD_API_TOKEN \
  --cloud-site-url your-domain.atlassian.net
```

This single command will:
1. Load the mapping file
2. Auto-populate ALL Cloud IDs by querying the Cloud API
3. Fix automation rules with the populated mappings
4. Save both the updated mapping and fixed rules

**Outputs:**
- `datacenter_cloud_mapping_populated_YYYY-MM-DD.json`
- `automation_rules_fixed_cloud_YYYY-MM-DD.json`

**Skip to Step 4 below.**

#### Step 3 (Alternative): Manual Population (Old Method)

If you prefer manual control or the auto-population fails for some entities:

<details>
<summary>Click to expand manual population steps</summary>

Open `datacenter_cloud_mapping.json` and fill in the Cloud IDs:

1. **Projects**: Match by `key` (preferred) or `name`
   - Find in Cloud: Project Settings → Project Details
   - Or use API: `GET /rest/api/3/project`

2. **Custom Fields**: Match by `name` and `field_type`
   - Find in Cloud: Settings → Issues → Custom Fields
   - Or use API: `GET /rest/api/3/field`

3. **Issue Types**: Match by `name`
   - Find in Cloud: Settings → Issues → Issue Types
   - Or use API: `GET /rest/api/3/issuetype`

4. **Statuses**: Match by `name` and `category`
   - Find in Cloud: Settings → Issues → Statuses
   - Or use API: `GET /rest/api/3/status`

5. **Users**: Match by `email` (preferred) or `display_name`
   - Important: Cloud uses `accountId` (UUID format)
   - Use API: `GET /rest/api/3/user/search?query=<email>`

Save the completed mapping file.

Then use `fix-json` mode with the mapping file:

```bash
node index.js fix-json \
  --mapping-file /path/to/datacenter_cloud_mapping.json
```

When prompted, enter the path to your `automation.json` file.

**Output:** `automation_rules_fixed_cloud_YYYY-MM-DD.json`

</details>

#### Step 4: Import to Cloud

**Option A - Manual UI Import:**
1. Log into Jira Cloud
2. Go to **Project Settings → Automation** (or **Settings → System → Global Automation**)
3. Click **Import rules**
4. Upload `automation_rules_fixed_cloud_YYYY-MM-DD.json`
5. Review and enable rules

**Option B - Automated Import (if supported):**
```bash
node index.js import-json \
  --source-username datacenter@example.com \
  --source-token DATACENTER_TOKEN \
  --source-site-url datacenter.domain.com \
  --source-cloud-id CLOUD_ID \
  --target-username cloud@example.com \
  --target-token CLOUD_TOKEN \
  --target-site-url cloud-domain.atlassian.net \
  --target-cloud-id CLOUD_ID
```
> Note: This may not work directly with Data Center; use Option A if issues occur.

### Data Center Migration Limitations

1. **Custom Field Options**: Multi-select and cascading field options are not automatically mapped
2. **Workflow Differences**: Status transitions must exist in Cloud workflows
3. **User Deactivations**: Deactivated Data Center users won't have Cloud accounts
4. **Smart Values**: Some Data Center-specific smart values may not work in Cloud
5. **App-specific Fields**: Custom fields from Data Center apps may not exist in Cloud

### Troubleshooting Data Center Migration

**Problem:** Mapping file shows "NOT_FOUND" for entities  
**Solution:** Those entities don't exist in Data Center. Create them manually or remove rules that reference them.

**Problem:** Import fails with "Invalid field" errors  
**Solution:** The field doesn't exist in Cloud. Update the mapping or remove that field from rules.

**Problem:** User mappings are incomplete  
**Solution:** Use Cloud's user search API to find accountIds by email. Deactivated users won't have accounts.

**Problem:** Rules import but don't work correctly  
**Solution:** Review workflow transitions, custom field configurations, and smart values used in rules.

## Common Workflows

### Workflow 1: Cloud-to-Cloud Project Migration

1. Export rules from source: `generate-json`
2. Fix IDs for target: `fix-json` (Cloud-to-Cloud mode)
3. Manually import the fixed JSON to target

### Workflow 2: Complete Cloud-to-Cloud Automated Migration

Use `import-json` mode for a fully automated end-to-end migration with interactive project selection.

### Workflow 3: Data Center-to-Cloud Migration (NEW - Automated)

**RECOMMENDED:** Use the new integrated mode:

1. Export automation rules from Data Center UI → `automation.json`
2. Run bash script to generate mapping file → `datacenter_cloud_mapping.json`
3. Run `datacenter-to-cloud` mode (auto-populates IDs + fixes rules)
4. Import fixed rules to Cloud

**Alternative (Old Method):**
Follow the [Data Center Migration Workflow](#data-center-migration-workflow) steps for manual ID population.

### Workflow 4: Sandbox to Production

Use `consolidation-sandbox` mode to safely migrate tested rules from sandbox to production.

### Workflow 5: Enable All Disabled Rules

Use `blanket` mode to quickly enable all disabled rules (with email safety checks).

## Error Handling

The tool includes comprehensive error handling:
- HTTP errors are caught and logged with status codes
- Failed rule imports are tracked and reported
- Duplicate rule names are detected before import
- Missing ID mappings are logged as warnings

## Logging Levels

- **INFO**: General progress and confirmations
- **WARN**: Non-critical issues (missing mappings, duplicates, etc.)
- **ERROR**: Critical failures
- **DEBUG**: Detailed technical information (written to evidence.log)

## Troubleshooting

### "Cloud ID not found"

Make sure you're using the correct Cloud ID from `https://YOUR_DOMAIN.atlassian.net/_edge/tenant_info`

### "Authentication failed"

Verify your API token is valid and has the correct permissions for automation rules.

### "Missing ID mappings"

Some projects or issue types don't exist in the target instance. The tool will log warnings but continue processing.

### Rules not being enabled

Check if the rules have email actions - they are kept disabled for safety.

## API Rate Limiting

The tool respects Jira API rate limits. If you hit rate limits:
- Reduce the number of rules being processed
- Add delays between operations
- Contact Atlassian support for rate limit increases

## Security Notes

- API tokens are passed via command line arguments
- Never commit API tokens to version control
- Use environment variables or secure vaults in production
- Evidence logs may contain sensitive information - secure them appropriately

## License

ISC

## Support

For issues, questions, or contributions, please contact your system administrator.
