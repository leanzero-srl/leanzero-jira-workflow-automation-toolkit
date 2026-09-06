const fs = require("fs");

function normalizeName(name) {
  if (name == null) return "";
  return String(name).normalize("NFC").trim();
}

class FilterMapper {
  constructor({ cloudClient, dcClient, log }) {
    this.cloudClient = cloudClient;
    this.dcClient = dcClient;
    this.log = log || console.log;

    // DC id (string) -> DC filter name (string) or null if deleted/inaccessible
    this.dcIdToName = new Map();
    // Normalized Cloud name (string) -> { status, cloudId?, candidates? }
    this.nameToCloudResult = new Map();
    // Normalized Cloud name -> array of { id, name } (populated when we have all Cloud filters)
    this.cloudByName = null;
  }

  /**
   * Seeds the Cloud name→filter[] index from an already-fetched list (to avoid per-name API hits
   * when we've already paginated through /filter/search).
   * @param {Array<{id,name}>} filters
   */
  seedCloudFilters(filters) {
    this.cloudByName = new Map();
    for (const f of filters) {
      const key = normalizeName(f.name);
      if (!this.cloudByName.has(key)) this.cloudByName.set(key, []);
      this.cloudByName.get(key).push({ id: String(f.id), name: f.name });
    }
  }

  /**
   * Preloads a DC id→name mapping from a JSON or CSV file.
   * JSON: either { "12012": "Name", ... } or [{ id, name }, ...]
   * CSV : header row `id,name` followed by rows. Names containing commas must be quoted.
   */
  loadDcDump(filePath) {
    const raw = fs.readFileSync(filePath, "utf8");
    let count = 0;

    if (filePath.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && entry.id != null && entry.name != null) {
            this.dcIdToName.set(String(entry.id), String(entry.name));
            count++;
          }
        }
      } else if (parsed && typeof parsed === "object") {
        for (const [id, name] of Object.entries(parsed)) {
          this.dcIdToName.set(String(id), String(name));
          count++;
        }
      }
    } else {
      const lines = raw.split(/\r?\n/);
      let headerSkipped = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        if (!headerSkipped) {
          headerSkipped = true;
          if (/^\s*id\s*,/i.test(line)) continue;
        }
        const [idPart, ...rest] = parseCsvRow(line);
        const namePart = rest.join(",");
        if (idPart != null && namePart != null) {
          this.dcIdToName.set(String(idPart).trim(), namePart);
          count++;
        }
      }
    }

    this.log(`  Preloaded ${count} DC filter(s) from ${filePath}`);
    return count;
  }

  /**
   * Returns the DC filter name for `dcId`, or `null` if the filter is deleted/inaccessible.
   * Cached.
   */
  async resolveDcName(dcId) {
    const key = String(dcId);
    if (this.dcIdToName.has(key)) return this.dcIdToName.get(key);

    if (!this.dcClient) {
      this.dcIdToName.set(key, null);
      return null;
    }

    try {
      const filter = await this.dcClient.getFilter(key);
      const name = filter ? filter.name : null;
      this.dcIdToName.set(key, name);
      return name;
    } catch (err) {
      this.log(`  [mapper] DC getFilter(${key}) error: ${err.message}`);
      this.dcIdToName.set(key, null);
      return null;
    }
  }

  /**
   * Resolves a filter name to a Cloud filter id (strict name equality after Unicode NFC normalize).
   * Returns { status: "ok" | "not_found" | "collision", cloudId?, candidates? }.
   * Cached.
   */
  async resolveCloudIdByName(name) {
    const key = normalizeName(name);
    if (this.nameToCloudResult.has(key)) return this.nameToCloudResult.get(key);

    let matches = [];
    if (this.cloudByName && this.cloudByName.has(key)) {
      matches = this.cloudByName.get(key);
    } else {
      // Fall back to Cloud /filter/search API for names not in our pre-indexed set.
      try {
        const fetched = await this.cloudClient.searchFilterByName(name);
        for (const f of fetched || []) {
          if (normalizeName(f.name) === key) {
            matches.push({ id: String(f.id), name: f.name });
          }
        }
      } catch (err) {
        this.log(`  [mapper] Cloud searchFilterByName(${name}) error: ${err.message}`);
      }
    }

    let result;
    if (matches.length === 0) {
      result = { status: "not_found" };
    } else if (matches.length > 1) {
      result = {
        status: "collision",
        candidates: matches.map((m) => m.id),
      };
    } else {
      result = { status: "ok", cloudId: matches[0].id };
    }

    this.nameToCloudResult.set(key, result);
    return result;
  }
}

/**
 * Minimal CSV row parser that handles double-quoted fields with embedded commas / "" escapes.
 * Returns an array of field strings.
 */
function parseCsvRow(line) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"' && cur === "") {
        inQuote = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

module.exports = FilterMapper;
module.exports.normalizeName = normalizeName;
