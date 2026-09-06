const crypto = require("crypto");

function uuidv4() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const buf = crypto.randomBytes(16);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function isoNow() {
  return new Date().toISOString();
}

function resolveEnvValue(value) {
  if (typeof value !== "string") return value;
  if (!value.startsWith("env:")) return value;
  const name = value.slice(4);
  const v = process.env[name];
  return v === undefined ? null : v;
}

function resolveConfigEnvIndirections(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(resolveConfigEnvIndirections);
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveConfigEnvIndirections(v);
    }
    return out;
  }
  if (typeof obj === "string") return resolveEnvValue(obj);
  return obj;
}

function safeFilename(name) {
  return String(name || "unnamed").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

function hashParams(parameters) {
  const normalized = {};
  const keys = Object.keys(parameters || {}).sort();
  for (const k of keys) {
    if (k === "id" || k === "tag" || k === "disabled") continue;
    normalized[k] = parameters[k];
  }
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 16);
}

// Deterministic per-DC-rule identity. Two collects of the same DC source produce
// the same id; emitted Cloud rules carry it in `parameters.migrationSourceId`.
// This is the dedup anchor that survives mapper changes and fingerprint
// hardening — the semantic fingerprint can drift across code revisions, but the
// migration id stays bound to the (workflow, transition, slot, dcType) tuple.
function computeMigrationSourceId({
  workflowName,
  transitionId,
  transitionName,
  ruleCategory,
  pathWithinTransition,
  dcType,
}) {
  const txnKey =
    transitionId != null && transitionId !== ""
      ? `id:${transitionId}`
      : `name:${transitionName || ""}`;
  const raw = [
    workflowName || "",
    txnKey,
    ruleCategory || "",
    pathWithinTransition || "",
    dcType || "",
  ].join("|");
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

// Extract the migrationSourceId fingerprint from a rule, if present. Used by
// dedup to anchor identity to the DC source rather than rule content (which
// drifts across mapper revisions). Returns null for rules without the tag —
// callers fall back to the semantic fingerprint.
function migrationFingerprint(rule) {
  const id = rule && rule.parameters && rule.parameters.migrationSourceId;
  return id ? `migration:${id}` : null;
}

function stringifyParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

class Logger {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    this.fs = require("fs");
    if (logFilePath) {
      const dir = require("path").dirname(logFilePath);
      if (!this.fs.existsSync(dir)) this.fs.mkdirSync(dir, { recursive: true });
    }
  }
  _write(level, msg) {
    const line = `[${isoNow()}] [${level}] ${msg}`;
    console.log(line);
    if (this.logFilePath) {
      try {
        this.fs.appendFileSync(this.logFilePath, line + "\n");
      } catch {
        // ignore disk errors; console output is authoritative
      }
    }
  }
  info(msg) { this._write("INFO", msg); }
  warn(msg) { this._write("WARN", msg); }
  error(msg) { this._write("ERROR", msg); }
  debug(msg) { if (process.env.DEBUG) this._write("DEBUG", msg); }
}

module.exports = {
  uuidv4,
  timestampSlug,
  isoNow,
  resolveEnvValue,
  resolveConfigEnvIndirections,
  safeFilename,
  hashParams,
  stringifyParams,
  computeMigrationSourceId,
  migrationFingerprint,
  Logger,
};
