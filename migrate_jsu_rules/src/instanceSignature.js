/**
 * Instance signature: a stable identifier for the (DC source, Cloud target,
 * XML input) tuple that produced a `--collect` artifact set.
 *
 * The collector stamps this into `metadata.json` and a human-readable
 * `INSTANCE.txt`. The applier checks the stamped signature against the
 * currently-configured DC + Cloud URLs and refuses to proceed when they
 * disagree (unless `--allow-instance-mismatch` is passed).
 *
 * Why this matters
 * ----------------
 * Every artifact in a collect dir — `field_remapping_resolved.json`,
 * `dc_status_catalog.json`, `cloud_target_workflows.json`, every
 * `update_payload_<wf>.json` — is computed against a specific (DC,
 * Cloud) pair. Re-using a collect dir against a different Cloud target
 * silently corrupts the new instance: customfield IDs from the OLD Cloud
 * leak into rules pushed at the NEW Cloud, dedup snapshots compare against
 * the wrong workflow, validation cache misses surface as nonsensical
 * errors. A 1-minute mistake can write hours of migration to the wrong
 * tenant.
 *
 * What identifies an instance
 * ---------------------------
 * `dcBaseUrl`     — `config.dc.baseUrl` after env-resolution. Empty when
 *                   --xml-dir runs without a DC connection (XML-only
 *                   collect with no DC field catalog).
 * `cloudBaseUrl`  — `config.cloud.baseUrl` after env-resolution. Always
 *                   present (apply needs Cloud).
 * `xmlDir`        — Absolute resolved path of the XML source directory
 *                   when --xml-dir was used; null otherwise. Two
 *                   collects against the same DC but different XML
 *                   exports MUST be treated as distinct.
 *
 * Two signatures are "compatible" when their dcBaseUrl AND cloudBaseUrl
 * agree (case-insensitive, trailing-slash insensitive). xmlDir is recorded
 * for audit but is NOT part of compatibility (the operator may relocate
 * an XML dump between collect and re-runs).
 */

const crypto = require("crypto");

function _normalizeUrl(u) {
  if (!u) return "";
  return String(u)
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
}

/**
 * Extract the {dcBaseUrl, cloudBaseUrl, xmlDir} triple from a config + run
 * options. Used at COLLECT time to stamp the artifacts and at APPLY time to
 * compute the "currently-configured" signature for comparison.
 */
function extractInstanceFromConfig(config, options = {}) {
  const dc = (config && config.dc) || {};
  const cloud = (config && config.cloud) || {};
  return {
    dcBaseUrl: _normalizeUrl(dc.baseUrl || ""),
    cloudBaseUrl: _normalizeUrl(cloud.baseUrl || ""),
    xmlDir: options.xmlDir ? require("path").resolve(options.xmlDir) : null,
  };
}

/**
 * Compute a short stable identifier (8 hex) for use in log lines, file
 * names, and quick visual comparison. Built only from {dcBaseUrl,
 * cloudBaseUrl} since those are the compatibility-relevant axes.
 */
function fingerprint(triple) {
  const stable = [
    `dc:${triple.dcBaseUrl || ""}`,
    `cloud:${triple.cloudBaseUrl || ""}`,
  ].join("|");
  return crypto.createHash("sha1").update(stable).digest("hex").slice(0, 8);
}

/**
 * Build the full {fingerprint, dcBaseUrl, cloudBaseUrl, xmlDir, capturedAt}
 * record stamped into metadata.json by the collector.
 */
function buildSignatureRecord(config, options = {}) {
  const triple = extractInstanceFromConfig(config, options);
  return {
    fingerprint: fingerprint(triple),
    dcBaseUrl: triple.dcBaseUrl,
    cloudBaseUrl: triple.cloudBaseUrl,
    xmlDir: triple.xmlDir,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Render the signature as a human-readable INSTANCE.txt content string.
 * Operator-facing: drop into the collect dir so anyone glancing at the
 * folder can immediately see which DC/Cloud pair produced it.
 */
function renderInstanceTxt(record) {
  return [
    "Jira DC→Cloud JSU migration — collect-dir instance stamp",
    "===========================================================",
    "",
    `Captured at:   ${record.capturedAt || "(unknown)"}`,
    `Fingerprint:   ${record.fingerprint || "(unknown)"}`,
    `DC base URL:   ${record.dcBaseUrl || "(none — XML-only collect with no DC connection)"}`,
    `Cloud base:    ${record.cloudBaseUrl || "(unknown)"}`,
    `XML dir:       ${record.xmlDir || "(REST-based collect, no XML directory)"}`,
    "",
    "This collect dir is bound to the (DC, Cloud) pair above. Running",
    "--apply against a Cloud tenant whose baseUrl differs will be rejected",
    "unless --allow-instance-mismatch is passed. To start fresh against a new",
    "instance pair, run --collect with --fresh-start to a new dir.",
    "",
  ].join("\n");
}

/**
 * Reasons returned by `compareSignatures` describing why a stored signature
 * is incompatible with the current config. Each is a short kebab-case slug
 * the caller can map to error messages without parsing free-form text.
 */
const MISMATCH_REASONS = {
  CLOUD_BASEURL: "cloud-baseurl-mismatch",
  DC_BASEURL: "dc-baseurl-mismatch",
  NO_STORED: "no-stored-signature",
};

/**
 * Compare a stored signature record (from metadata.json) to the
 * currently-configured triple (from config + options). Returns:
 *
 *   { compatible: true,  storedFingerprint, currentFingerprint }
 *   { compatible: false, reason: <slug>, details: <human string>,
 *     storedFingerprint, currentFingerprint }
 *
 * Both URLs compared are normalized (lowercased, trailing-slash stripped).
 * Only `dcBaseUrl` + `cloudBaseUrl` count for compatibility. xmlDir is
 * recorded for audit only.
 *
 * When the stored record is missing or has empty URLs, returns
 * `compatible: false, reason: NO_STORED` — the operator can decide to
 * proceed via --allow-instance-mismatch (e.g. for a legacy collect dir
 * pre-dating this stamping).
 */
function compareSignatures(stored, currentTriple) {
  const cur = {
    dcBaseUrl: _normalizeUrl(currentTriple.dcBaseUrl || ""),
    cloudBaseUrl: _normalizeUrl(currentTriple.cloudBaseUrl || ""),
  };
  const currentFingerprint = fingerprint(cur);
  if (!stored || (!stored.dcBaseUrl && !stored.cloudBaseUrl)) {
    return {
      compatible: false,
      reason: MISMATCH_REASONS.NO_STORED,
      details:
        "collect dir has no instance signature stamped in metadata.json — " +
        "either pre-dates the fresh-start safety check, or was hand-edited",
      storedFingerprint: stored && stored.fingerprint ? stored.fingerprint : null,
      currentFingerprint,
    };
  }
  const stor = {
    dcBaseUrl: _normalizeUrl(stored.dcBaseUrl || ""),
    cloudBaseUrl: _normalizeUrl(stored.cloudBaseUrl || ""),
  };
  if (stor.cloudBaseUrl && cur.cloudBaseUrl && stor.cloudBaseUrl !== cur.cloudBaseUrl) {
    return {
      compatible: false,
      reason: MISMATCH_REASONS.CLOUD_BASEURL,
      details: `Cloud baseUrl mismatch: collect-dir was built for "${stor.cloudBaseUrl}" but current config points at "${cur.cloudBaseUrl}"`,
      storedFingerprint: stored.fingerprint,
      currentFingerprint,
    };
  }
  if (stor.dcBaseUrl && cur.dcBaseUrl && stor.dcBaseUrl !== cur.dcBaseUrl) {
    return {
      compatible: false,
      reason: MISMATCH_REASONS.DC_BASEURL,
      details: `DC baseUrl mismatch: collect-dir was built against "${stor.dcBaseUrl}" but current config points at "${cur.dcBaseUrl}"`,
      storedFingerprint: stored.fingerprint,
      currentFingerprint,
    };
  }
  return {
    compatible: true,
    storedFingerprint: stored.fingerprint,
    currentFingerprint,
  };
}

/**
 * Compare a collect-dir's stamped signature (read from `metadata.json`) to the
 * currently-configured (DC, Cloud) URLs and decide whether the run should
 * proceed.
 *
 * Returns nothing on a clean match (logs an OK line). Throws when the URLs
 * disagree unless `allowMismatch` is true. Two soft cases — `NO_STORED` (legacy
 * collect dir without a stamp) and explicit `allowMismatch` — log a warning and
 * return.
 *
 * Callers: `JsuApplier._verifyInstanceSignature` and `WorkflowSanitizer` both
 * use this helper so the safety semantics stay identical.
 *
 * @param {object} metadata        - Parsed `metadata.json` from the collect dir.
 * @param {object} config          - Resolved config (with `dc.baseUrl`,
 *                                   `cloud.baseUrl`).
 * @param {object} opts
 * @param {boolean} opts.allowMismatch - When true, downgrade hard mismatches to
 *                                       a warning and proceed.
 * @param {object} opts.log         - Logger with `.info` / `.warn`.
 * @param {string} [opts.modeLabel] - Label for the run kind shown in errors
 *                                    (default "apply"). Sanitizer passes
 *                                    `"sanitize"`.
 */
function verifyInstanceSignature(metadata, config, opts = {}) {
  const log = opts.log || console;
  const allowMismatch = !!opts.allowMismatch;
  const modeLabel = opts.modeLabel || "apply";
  const stored = (metadata && metadata.instanceSignature) || null;
  const currentTriple = extractInstanceFromConfig(config, { xmlDir: null });
  const result = compareSignatures(stored, currentTriple);
  if (result.compatible) {
    const fpNote =
      result.storedFingerprint && result.storedFingerprint !== result.currentFingerprint
        ? ` (stored fp=${result.storedFingerprint} differs from recomputed fp=${result.currentFingerprint}; URLs match — accepting)`
        : ` (fp=${result.currentFingerprint})`;
    log.info(
      `Instance signature OK: collect-dir's (DC, Cloud) URLs match current config${fpNote}`,
    );
    return;
  }
  const header =
    `INSTANCE MISMATCH: collect-dir was built for a different (DC, Cloud) pair than the one this run is configured to write to.`;
  const detail =
    `  reason:  ${result.reason}\n` +
    `  details: ${result.details}\n` +
    `  collect-dir fp: ${result.storedFingerprint || "(none)"}\n` +
    `  current fp:     ${result.currentFingerprint}`;
  if (allowMismatch) {
    log.warn(header);
    log.warn(detail);
    log.warn(
      "  Continuing only because --allow-instance-mismatch was passed. " +
      "Field IDs, status IDs, and validation responses will be sent to the " +
      "currently-configured Cloud — make sure that's what you want.",
    );
    return;
  }
  if (result.reason === MISMATCH_REASONS.NO_STORED) {
    log.warn(
      `Collect dir has no instance signature. Pre-dates the fresh-start ` +
      `safety check, or metadata.json was hand-edited. ` +
      `Proceeding — but verify this is the right collect dir for tenant ` +
      `"${currentTriple.cloudBaseUrl}". Re-run --collect to stamp a fresh ` +
      `signature for future runs.`,
    );
    return;
  }
  throw new Error(
    `${header}\n${detail}\n` +
    `\n` +
    `Two ways out:\n` +
    `  1. (RECOMMENDED) Run a fresh --collect against the new instance pair:\n` +
    `       node main/migrate_jsu_rules.js --collect --fresh-start --xml-dir <new-xmls>\n` +
    `  2. Override (DANGEROUS, only if you really mean it):\n` +
    `       --${modeLabel} --collect-dir <dir> --allow-instance-mismatch\n` +
    `\n` +
    `See README.md → "Fresh-start workflow for a new source/target instance pair".`,
  );
}

module.exports = {
  extractInstanceFromConfig,
  fingerprint,
  buildSignatureRecord,
  renderInstanceTxt,
  compareSignatures,
  verifyInstanceSignature,
  MISMATCH_REASONS,
};
