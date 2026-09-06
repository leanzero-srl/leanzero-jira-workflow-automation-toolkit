/**
 * Structural alignment between DC transitions (from the inventory / plan rows)
 * and Cloud transitions (from POST /rest/api/3/workflows).
 *
 * Cloud's new-shape transition object:
 *   { id, type: "GLOBAL"|"INITIAL"|"DIRECTED",
 *     name, toStatusReference,
 *     links: [{ fromStatusReference, fromPort?, toPort? }],
 *     actions[], validators[], conditions{}, ... }
 *
 * Match priority (most specific first):
 *
 *   1. ID parity. JCMA-migrated workflows preserve DC action ids on Cloud
 *      transitions (verified live: e.g. DC action 491 ↔ Cloud transition id
 *      "491"). Highest confidence.
 *
 *   2. Structural triple. (name, toStatusReference, fromStatusReference set
 *      contains DC.from). Disambiguates duplicate-named transitions when ID
 *      parity fails, and handles Cloud's collapse of OSWorkflow common-actions
 *      into a single transition with multiple `links[]`.
 *
 *   3. Unique-name fallback. Only if exactly one Cloud transition has that
 *      name across the whole workflow. If multiple Cloud transitions share the
 *      name, we REFUSE to match — the previous behaviour was to spray the rule
 *      onto every same-named transition, which corrupted unrelated transitions
 *      whenever DC had legitimate distinct actions sharing a display name.
 */

function _str(v) {
  return v == null ? null : String(v);
}

/**
 * Build a fast index over Cloud transitions for use by resolveCloudTransition.
 * Returns:
 *   { byId: Map<id, transition>,
 *     byName: Map<name, transition[]>,
 *     all: transition[] }
 */
function indexCloudTransitions(cloudWorkflow) {
  const all = (cloudWorkflow && cloudWorkflow.transitions) || [];
  const byId = new Map();
  const byName = new Map();
  for (const ct of all) {
    if (!ct) continue;
    if (ct.id != null) byId.set(_str(ct.id), ct);
    if (ct.name) {
      if (!byName.has(ct.name)) byName.set(ct.name, []);
      byName.get(ct.name).push(ct);
    }
  }
  return { byId, byName, all };
}

/**
 * Resolve a single DC transition (described by identity fields from a plan
 * row) to a single Cloud transition. Returns:
 *   { transition, matchType: "id"|"triple"|"unique-name", reason: null }
 *   { transition: null, matchType: null, reason: "<why>" }   (no match)
 *
 * @param {object} idx - the result of indexCloudTransitions()
 * @param {object} dc  - { transitionId, transitionName, transitionFromStatusIds: [], transitionToStatusId, transitionType }
 */
function resolveCloudTransition(idx, dc) {
  if (!idx || !dc) return { transition: null, matchType: null, reason: "missing input" };
  const dcId = _str(dc.transitionId);
  const dcName = dc.transitionName || null;
  const dcType = dc.transitionType || null;
  const dcTo = _str(dc.transitionToStatusId);
  const dcFromList = Array.isArray(dc.transitionFromStatusIds)
    ? dc.transitionFromStatusIds.map(_str).filter(Boolean)
    : [];

  // 1. ID parity
  if (dcId && idx.byId.has(dcId)) {
    return { transition: idx.byId.get(dcId), matchType: "id", reason: null };
  }

  // 2. Structural triple
  if (dcName && idx.byName.has(dcName)) {
    const candidates = idx.byName.get(dcName);
    const tripleHits = [];
    for (const ct of candidates) {
      if (!_typeMatches(ct.type, dcType)) continue;
      if (!_toStatusMatches(ct, dcTo)) continue;
      if (!_fromStatusMatches(ct, dcFromList)) continue;
      tripleHits.push(ct);
    }
    if (tripleHits.length === 1) {
      return { transition: tripleHits[0], matchType: "triple", reason: null };
    }
    if (tripleHits.length > 1) {
      // Genuinely ambiguous on (name, type, to, from) — should never happen in
      // a well-formed Jira workflow. Refuse rather than guess.
      return {
        transition: null,
        matchType: null,
        reason: `${tripleHits.length} Cloud transitions match "${dcName}" on (type=${dcType}, to=${dcTo}, from=${dcFromList.join(",")})`,
      };
    }
  }

  // 3. Unique-name fallback (only safe when exactly one Cloud transition has
  // this name — otherwise we'd be back to the old spray bug).
  if (dcName && idx.byName.has(dcName)) {
    const candidates = idx.byName.get(dcName);
    if (candidates.length === 1) {
      return { transition: candidates[0], matchType: "unique-name", reason: null };
    }
    return {
      transition: null,
      matchType: null,
      reason: `name "${dcName}" matches ${candidates.length} Cloud transitions; structural fields (type=${dcType}, to=${dcTo}, from=${dcFromList.join(",")}) didn't disambiguate`,
    };
  }

  return {
    transition: null,
    matchType: null,
    reason: `no Cloud transition with name "${dcName}" (DC id=${dcId})`,
  };
}

function _typeMatches(cloudType, dcType) {
  // If either side is missing the type, don't use it as a filter.
  if (!cloudType || !dcType) return true;
  return cloudType === dcType;
}

function _toStatusMatches(cloudTxn, dcToStatusId) {
  if (!dcToStatusId) return true;
  const cloudTo = _str(cloudTxn && cloudTxn.toStatusReference);
  if (!cloudTo) return true; // GLOBAL/INITIAL may omit; don't reject on missing
  return cloudTo === dcToStatusId;
}

function _fromStatusMatches(cloudTxn, dcFromList) {
  if (!cloudTxn) return false;
  // GLOBAL transitions don't have from-status semantics on Cloud (links is []).
  if (cloudTxn.type === "GLOBAL") return true;
  // INITIAL transitions have no from-status.
  if (cloudTxn.type === "INITIAL") return dcFromList.length === 0;
  const links = Array.isArray(cloudTxn.links) ? cloudTxn.links : [];
  if (links.length === 0) {
    // DIRECTED but no links — treat as compatible (don't reject on missing).
    return true;
  }
  if (dcFromList.length === 0) {
    // DC didn't tell us from-status; don't reject on missing.
    return true;
  }
  const cloudFromSet = new Set(
    links.map((l) => _str(l && l.fromStatusReference)).filter(Boolean),
  );
  // OSWorkflow common-actions get fanned out by the parser into one DC record
  // per source step, each with a single `from`. We only need the DC's from to
  // appear among Cloud's links — this is what makes 571 (single Cloud txn with
  // 3 links) line up against the 3 DC fan-out records that all reference it.
  for (const f of dcFromList) {
    if (cloudFromSet.has(f)) return true;
  }
  return false;
}

/**
 * Audit-style alignment summary across an inventory transition list against a
 * Cloud workflow. Used by the applier to log "matched-by-id / triple /
 * unique-name / unmatched" counts so post-migration verification has a
 * machine-readable trail.
 */
function alignTransitions(dcTransitions, cloudWorkflow) {
  const idx = indexCloudTransitions(cloudWorkflow);
  const matched = [];
  const unmatched = [];
  const matchTypeCounts = { id: 0, triple: 0, "unique-name": 0 };
  for (const dt of dcTransitions || []) {
    const res = resolveCloudTransition(idx, dt);
    if (res.transition) {
      matchTypeCounts[res.matchType]++;
      matched.push({
        dc: dt,
        cloudTransitionId: res.transition.id,
        matchType: res.matchType,
      });
    } else {
      unmatched.push({ dc: dt, reason: res.reason });
    }
  }
  // Cloud transitions with no DC counterpart — left alone by the applier.
  const dcCloudIds = new Set(matched.map((m) => _str(m.cloudTransitionId)));
  const cloudOnly = idx.all
    .filter((ct) => !dcCloudIds.has(_str(ct.id)))
    .map((ct) => ({ id: ct.id, name: ct.name, type: ct.type }));
  return { matched, unmatched, matchTypeCounts, cloudOnly };
}

module.exports = {
  alignTransitions,
  indexCloudTransitions,
  resolveCloudTransition,
};
