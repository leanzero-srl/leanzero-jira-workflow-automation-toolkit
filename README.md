# LeanZero Jira Workflow & Automation Toolkit

Four Node.js tools for the part of a Jira migration that no assistant handles: **workflow rules,
app-specific workflow extensions, automation rules, and the JQL inside saved filters.**

Apache-2.0. Public REST only.

---

## The problem this exists for

Issues migrate. The *logic* around them does not.

- **Workflow rules referencing app classes** — a DC validator from a workflow-extensions app is a
  Java class name. Cloud has no Java. The rule has to be re-expressed as a native Cloud rule or as
  the Cloud app's equivalent, or it silently does nothing.
- **Every entity id changes** — statuses, issue types, screens, events, roles, groups, priorities,
  resolutions, link types, security levels, custom fields. A workflow copied verbatim between
  instances is a workflow full of dangling references.
- **Automation rules** carry ids in their components, their smart values and their JQL, and the rule
  actor is usually an account that has no permissions on the target.
- **Saved filters** are copied body-for-body, so their JQL still names DC filter ids, DC custom field
  ids, DC asset fields and functions that do not exist on Cloud. The filter loads and returns the
  wrong answer, or nothing.

---

## What is in the box

| Tool | What it does |
|---|---|
| [`clone_workflow_rules`](./clone_workflow_rules) | Collects, transforms and applies Jira Cloud workflow definitions — between instances or in place. Cross-instance entity-id remapping for statuses, issue types, screens, events, roles, groups, priorities, resolutions, link types, security levels and custom fields. Cleans up app Connect-prefix normalisation after a migration. Can also emit a ScriptRunner scaffold (`extensions.yaml` + Groovy stubs) for handover to a deployment tool. |
| [`migrate_jsu_rules`](./migrate_jsu_rules) | Reads OSWorkflow XML exported from DC, identifies workflow-extension rules by their Java class names, and translates each into either a **native Cloud rule** (`system:*`) or the **Cloud app equivalent** (`connect:*`), then updates the same-named Cloud workflow in place via the bulk workflow update API. Non-matching rules are left completely untouched. |
| [`automation_rules_migrator`](./automation_rules_migrator) | Exports every automation rule from a source Cloud site, builds source→target id maps, ensures the rule actor actually has the project access the automation engine requires, and imports the cleanly-mappable rules. Also has a **reconcile-in-place** mode that fixes and enables rules on a target without importing anything. |
| [`rewrite_filter_refs`](./rewrite_filter_refs) | Post-migration JQL cleanup for saved filters. Rewrites DC filter ids, `cf[N]` and `customfield_N` references, asset-field references and `ORDER BY` clauses; strips functions that do not exist on Cloud; validates project names; and repairs share permissions. |

---

## Start here

```bash
git clone https://github.com/leanzero-srl/leanzero-jira-workflow-automation-toolkit.git
cd leanzero-jira-workflow-automation-toolkit/clone_workflow_rules
npm install
cp .env.example .env
```

`migrate_jsu_rules` reuses `clone_workflow_rules`'s REST client and field mapper directly, so keep
them as siblings — do not move either directory.

---

## The order these are meant to be run in

```
1. rewrite_filter_refs        -- filters first: everything else is easier to verify with working JQL
2. clone_workflow_rules       -- workflows into place, in-place fixes or cross-instance clone
3. migrate_jsu_rules          -- then the app-specific rules inside those workflows
4. automation_rules_migrator  -- automation last: it depends on the workflows and fields existing
```

---

## How every tool in this repo behaves

**Validate before mutate.** Every workflow write is validated against Jira's own
`/workflows/update/validation` endpoint first, and validation errors are surfaced for review rather
than auto-fixed. Automation imports run `PLAN=1` first.

**Always-fresh deduplication.** Every apply re-fetches the live target and fingerprints its existing
rules *before* mutating. Anything already present is classified as such and never appended. A stale
plan cannot double-apply.

**Additive by default.** These tools add and correct rules. They do not delete rules they did not
recognise. The one exception is explicit: `migrate_jsu_rules` removes pre-existing rules whose custom
field references do not exist on Cloud, because those are already broken — and it reports every one.

**Operator workbooks, not just logs.** Runs emit a `manual_review_<timestamp>.xlsx` with one tab per
category needing human attention. That workbook is a checklist, not a sign-off: a migrated workflow
rule still deserves an expert eye in the Cloud UI.

**Backups before automation writes.** Full rule exports are written before any reconcile or import.

---

## The honest limitations

Stated up front, because discovering them mid-cutover is expensive:

- **Rule-type conversion is the biggest unknown.** The legacy workflow-search endpoint returns an old
  rule-`type` format that must be converted to Cloud's new rule keys. For **cloud→cloud** this is
  unnecessary and avoidable — use `clone_workflow_rules --cloud-to-cloud`, which reads the new-format
  endpoint directly. For DC→Cloud, verify the converted rules in the UI.
- **App config blobs are opaque.** Connect and Forge rule configuration is a stringified JSON blob
  the tools deliberately do not parse or rewrite.
- **Field *values* are not translated.** Field *ids* are mapped by name; the values inside a rule
  (status names, option labels) pass through verbatim. That is usually correct, because Cloud uses
  names too — but it is a pass-through, not a translation.
- **There is no rollback.** Re-running with prior state is the only undo. Take an export first.

---

## Licence

Apache-2.0. See [LICENSE](./LICENSE).

Built by [LeanZero](https://leanzero.net) during real Atlassian Cloud migrations.
