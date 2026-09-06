/**
 * One-line human-readable summary of a DC workflow rule.
 *
 * Used by `unmappedCsvWriter` to give operators a column they can scan in
 * Excel without having to expand `dcConfigPreview` JSON. Goal: tell the
 * operator WHAT the rule does, not WHICH class implements it.
 *
 * Examples:
 *   UpdateIssueCustomFieldPostFunction(field.name="customfield_11908",
 *     field.value="Yes")
 *       → "Set customfield_11908 = 'Yes'"
 *   FieldsRequiredValidator(hidFieldsList="cf_X@@cf_Y@@")
 *       → "Require fields: cf_X, cf_Y"
 *   EmailIssueFunction(subject="${issue.summary}", toAddresses="ops@x.com")
 *       → "Email '${issue.summary}' → ops@x.com"
 *
 * Falls back to `<class-tail>: <first config key>` for unknown shapes.
 */

const MAX = 120;

function truncate(s, max = MAX) {
  if (s == null) return "";
  const v = String(s).replace(/\s+/g, " ").trim();
  return v.length > max ? v.slice(0, max - 3) + "..." : v;
}

function listFromAtAt(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return String(raw).split(/@@|,/).map((s) => s.trim()).filter(Boolean);
}

function classTail(dcType) {
  if (!dcType) return "?";
  return String(dcType).split(".").pop() || dcType;
}

function summarizeRule(dcType, configuration) {
  const cfg = configuration || {};
  const t = classTail(dcType);

  // ─── JSU ───
  if (t === "UpdateIssueCustomFieldPostFunction") {
    const field = cfg["field.name"] || cfg.field || "?";
    const value = cfg["field.value"] != null ? cfg["field.value"] : "?";
    const append = cfg["append.value"] === "true" || cfg["append.value"] === true
      ? " (append)" : "";
    return truncate(`Set ${field} = '${value}'${append}`);
  }
  if (t === "ClearFieldValuePostFunction") {
    const field = cfg.field || cfg["field.name"] || "?";
    return truncate(`Clear field ${field}`);
  }
  if (t === "CopyValueFromOtherFieldPostFunction") {
    const src = cfg["field.copyFrom"] || cfg.sourceFieldId || cfg["field.source"] || "?";
    const dst = cfg["field.copyTo"] || cfg.targetFieldId || cfg["field.destination"] || "?";
    return truncate(`Copy ${src} → ${dst}`);
  }
  if (t === "FieldsRequiredValidator" || t === "FieldRequiredValidator") {
    const fields = listFromAtAt(cfg.hidFieldsList || cfg.fieldsRequired || cfg.fields);
    return truncate(`Require fields: ${fields.join(", ") || "?"}`);
  }
  if (t === "ValueFieldCondition") {
    const field = cfg.fieldsList || cfg.fieldId || cfg.field || "?";
    const value = cfg.fieldValue || cfg.value || "?";
    return truncate(`Condition: ${field} = '${value}'`);
  }
  if (t === "JqlCondition") {
    const jql = cfg.query || cfg.jqlquery || cfg.jql || cfg["jira.jql"] || "?";
    return truncate(`JQL condition: ${jql}`);
  }
  if (t === "UserIsInAnyRolesCondition") {
    const roles = listFromAtAt(cfg.hidRolesList || cfg["jira.projectroles"] || cfg.roles);
    return truncate(`User in roles: ${roles.join(", ") || "?"}`);
  }
  if (t === "UserIsInAnyGroupsCondition") {
    const groups = listFromAtAt(cfg.hidGroupsList || cfg["jira.groups"] || cfg.groups);
    return truncate(`User in groups: ${groups.join(", ") || "?"}`);
  }
  if (t === "UserIsInCustomFieldCondition") {
    const field = cfg.fieldName || cfg.field || "?";
    return truncate(`User is in field ${field}`);
  }
  if (t === "PreviousStatusCondition" || t === "PreviousStatusValidator") {
    const statuses = listFromAtAt(
      cfg["jira.previousstatus"] || cfg.previousStatuses || cfg.statuses,
    );
    return truncate(`Previous status: ${statuses.join(", ") || "?"}`);
  }
  if (t === "SubTaskBlockingCondition" || t === "SubtasksBlockingCondition") {
    const statuses = listFromAtAt(cfg["jira.allowed"] || cfg["jira.subtaskstatus"] || cfg.statuses);
    return truncate(`Subtasks block unless in: ${statuses.join(", ") || "?"}`);
  }
  if (t === "HideFromUserCondition") {
    const groups = listFromAtAt(cfg.hidGroupsList || cfg.groups);
    return truncate(`Hide from users not in: ${groups.join(", ") || "?"}`);
  }
  if (t === "NoOperationCondition") return "No-op condition";
  if (t === "AssignToCurrentUserFunction") return "Assign to current user";
  if (t === "LoggedInConditionValidator") return "Requires logged-in user";
  if (t === "RegexpFieldValidator") {
    const field = cfg.fieldId || cfg.field || "?";
    const regex = cfg.regexp || cfg.regex || "?";
    return truncate(`Validate ${field} matches /${regex}/`);
  }
  if (t === "DateCompareValidator" || t === "DateComparisonValidator") {
    const first = cfg.firstDate || cfg.firstDateFieldId || "?";
    const second = cfg.secondDate || cfg.secondDateFieldId || "?";
    const op = cfg.condition || cfg.comparison || "?";
    return truncate(`Date compare: ${first} ${op} ${second}`);
  }
  if (t === "UserPermissionValidator") {
    const perm = cfg.permission || cfg.permissionKey || "?";
    return truncate(`Requires permission: ${perm}`);
  }
  if (t === "CreateIssueFunction") {
    const proj = cfg.projectKey || cfg.targetProject || "?";
    const issType = cfg.issueType || cfg.targetIssueType || "?";
    return truncate(`Create issue in ${proj} (${issType})`);
  }
  if (t === "TransitionIssueFunction") {
    const target = cfg.transition || cfg.targetTransition || cfg.transitionName || "?";
    return truncate(`Transition issue → ${target}`);
  }
  if (t === "SendCustomEmailFunction") {
    const subject = cfg.subject || cfg["mail.subject"] || "?";
    return truncate(`Send custom email: '${subject}'`);
  }
  if (t === "SetFieldValueAutomaticallyFunction") {
    return "Set field value automatically (broad)";
  }

  // ─── JMWE ───
  if (t === "SetFieldValueFunction" || t === "SetIssueFieldsFunction") {
    let fieldsConfig = [];
    try { fieldsConfig = JSON.parse(cfg.fieldsConfig || cfg["fieldsConfig"] || "[]"); } catch {}
    if (Array.isArray(fieldsConfig) && fieldsConfig.length > 0) {
      const previews = fieldsConfig.slice(0, 3).map((f) => {
        const fk = f.fieldId || f.fieldKey || f.field || "?";
        const v = f.value != null ? String(f.value).slice(0, 30) : "?";
        return `${fk}='${v}'`;
      });
      const extra = fieldsConfig.length > 3 ? ` (+${fieldsConfig.length - 3} more)` : "";
      return truncate(`Set fields: ${previews.join(", ")}${extra}`);
    }
    const single = cfg.fieldKey || cfg.field || "?";
    return truncate(`Set field ${single}`);
  }
  if (t === "ClearFieldValueFunction") {
    const fields = listFromAtAt(cfg.fields || cfg.fieldIds);
    return truncate(`Clear fields: ${fields.join(", ") || "?"}`);
  }
  if (t === "CommentIssueFunction") {
    const comment = cfg.comment || "?";
    return truncate(`Add comment: '${comment}'`);
  }
  if (t === "EmailIssueFunction") {
    const subject = cfg.subject || "?";
    const to = cfg.toUsers || cfg.toAddresses || cfg.toEmails || cfg.toEmailsScript || "?";
    return truncate(`Email '${subject}' → ${to}`);
  }
  if (t === "CopyIssueFieldsFunction") {
    const raw = cfg.fieldMappings || cfg["jmwe.fieldmappings"] || cfg.mappings || cfg.copyFieldsConfig || "";
    let mappings = [];
    if (typeof raw === "string" && raw.trim().startsWith("[")) {
      try { mappings = JSON.parse(raw); } catch {}
    } else if (Array.isArray(raw)) {
      mappings = raw;
    } else {
      mappings = listFromAtAt(raw);
    }
    const target = cfg.targetIssue || cfg.issueSelector || "currentIssue";
    return truncate(`Copy ${mappings.length || "?"} field(s) to ${target}`);
  }
  if (t === "CopyFieldValueFromParentFunction") {
    const fields = listFromAtAt(cfg.fields);
    return truncate(`Copy from parent: ${fields.join(", ") || "?"}`);
  }
  if (t === "IncreaseFieldValueFunction") {
    const field = cfg.fieldId || cfg.field || "?";
    return truncate(`Increment ${field}`);
  }
  if (t === "AssignIssueFunction") {
    const target = cfg.user || cfg.assignTo || cfg.runAsType || "?";
    return truncate(`Assign to ${target}`);
  }
  if (t === "TransitionLinkedIssuesFunction") {
    const linkType = cfg.linkType || "?";
    const tx = cfg.transitionName || cfg.transition || "?";
    return truncate(`Transition ${linkType} → ${tx}`);
  }
  if (t === "GroovyFunction" || t === "GroovyValidator" || t === "GroovyCondition") {
    const script = cfg.script || cfg.groovyExpression || cfg.expression || "";
    return truncate(`Groovy ${t.replace("Groovy", "").toLowerCase()}: ${script}`);
  }
  if (t === "FieldHasSingleValueValidator") {
    const field = cfg.fieldKey || cfg.fieldId || cfg.field || "?";
    return truncate(`Validate ${field} has single value`);
  }
  if (t === "LinkedIssuesCondition" || t === "LinkedIssuesStatusCondition") {
    const linkType = cfg.linkType || cfg.linkTypeId || "?";
    const statuses = listFromAtAt(
      cfg["jira.linked.statuses"] || cfg.statuses || cfg.statusIds,
    );
    return truncate(`Linked-issue (${linkType}) in status: ${statuses.join(", ") || "?"}`);
  }
  if (t === "LinkedIssuesStatusValidator") {
    const linkType = cfg.linkType || cfg.linkTypeId || "?";
    return truncate(`Linked-issue (${linkType}) status validator`);
  }
  if (t === "CurrentStatusCondition") {
    const statuses = listFromAtAt(cfg.statuses || cfg.statusIds);
    return truncate(`Current status in: ${statuses.join(", ") || "?"}`);
  }
  if (t === "NonInteractiveCondition") return "Non-interactive only (no UI)";
  if (t === "GenericUserCondition" || t === "GenericUserValidator") {
    return "Generic user predicate (review)";
  }
  if (t === "ParentStatusValidator") {
    const statuses = listFromAtAt(cfg["jira.parentstatuses"] || cfg.statuses);
    return truncate(`Parent status in: ${statuses.join(", ") || "?"}`);
  }
  if (t === "CommentRequiredValidator") {
    return "Comment required";
  }
  if (t === "FieldChangedValidator") {
    const field = cfg.fieldId || cfg.field || "?";
    return truncate(`Field ${field} must change`);
  }

  // ─── BeeCom ───
  if (t === "LinkedTransitionFunction") {
    return truncate(`BeeCom: transition linked issue (${cfg.transitionName || "?"})`);
  }
  if (t === "CreateLinkedIssueFunction") {
    return truncate(`BeeCom: create linked issue`);
  }
  if (t === "ValueFieldPreconditionFunction") {
    return "BeeCom: value-field precondition";
  }
  if (t === "UserIsInAnyUsersCondition") {
    const users = listFromAtAt(cfg.usersList || cfg.users);
    return truncate(`User is one of: ${users.join(", ") || "?"}`);
  }

  // Generic fallback: class tail + first non-class.name key.
  const interesting = Object.entries(cfg)
    .filter(([k]) =>
      !k.startsWith("class.") && !k.endsWith("-uuid") &&
      !k.startsWith("jsu") && !k.startsWith("scopeType") &&
      !k.startsWith("preconditionAware") && k !== "uuid",
    )
    .slice(0, 2)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 30) : v}`);
  return truncate(`${t}${interesting.length > 0 ? " (" + interesting.join(", ") + ")" : ""}`);
}

module.exports = { summarizeRule, truncate, listFromAtAt };
