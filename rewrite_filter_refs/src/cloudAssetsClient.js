const https = require("https");

class CloudAssetsClient {
  constructor(workspaceId, apiToken) {
    this.workspaceId = workspaceId;
    this.apiToken = apiToken;
    this.hostname = "api.atlassian.com";
    this.basePath = `/jsm/assets/workspace/${workspaceId}/v1`;
    this.requestCount = 0;
    this.errorCount = 0;
    // Cache for resolved objects to avoid redundant AQL calls
    this.objectCache = new Map();
  }

  /**
   * Escape a string for use inside AQL double-quoted values.
   * Backslash-escapes double quotes and backslashes.
   */
  static escapeAqlValue(str) {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /**
   * Make an HTTPS request to the Cloud Assets API.
   * Uses separate counters for rate limit vs server error/network retries.
   */
  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };
    const maxRateLimitRetries = 5;
    const maxServerRetries = 3;

    return new Promise((resolve, reject) => {
      const fullPath = path.startsWith(this.basePath)
        ? path
        : this.basePath + path;

      const options = {
        hostname: this.hostname,
        port: 443,
        path: fullPath,
        method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      };

      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const retry = (newState) =>
        this.makeRequest(method, path, body, newState)
          .then(resolve)
          .catch(reject);

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (
            res.statusCode === 429 &&
            state.rateLimitAttempts < maxRateLimitRetries
          ) {
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 120000);
            console.log(
              `  [Assets] Rate limited (429), retrying in ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`,
            );
            setTimeout(
              () =>
                retry({
                  ...state,
                  rateLimitAttempts: state.rateLimitAttempts + 1,
                }),
              delay,
            );
            return;
          }

          if (
            res.statusCode >= 500 &&
            res.statusCode < 600 &&
            state.serverErrorAttempts < maxServerRetries
          ) {
            const delay = Math.min(
              1000 * Math.pow(2, state.serverErrorAttempts),
              10000,
            );
            console.log(
              `  [Assets] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`,
            );
            setTimeout(
              () =>
                retry({
                  ...state,
                  serverErrorAttempts: state.serverErrorAttempts + 1,
                }),
              delay,
            );
            return;
          }

          if (res.statusCode >= 400) {
            this.errorCount++;
            const error = new Error(
              `Assets API ${method} ${fullPath} returned ${res.statusCode}: ${data.substring(0, 500)}`,
            );
            error.statusCode = res.statusCode;
            reject(error);
            return;
          }

          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      });

      req.on("error", (err) => {
        this.errorCount++;
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          console.log(
            `  [Assets] Connection error: ${err.message}, retrying in ${delay / 1000}s`,
          );
          setTimeout(
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
            delay,
          );
          return;
        }
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          console.log(
            `  [Assets] Request timeout, retrying in ${delay / 1000}s`,
          );
          setTimeout(
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
            delay,
          );
          return;
        }
        reject(new Error(`Assets API request timeout: ${method} ${fullPath}`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Test connection to Cloud Assets API
   */
  async testConnection() {
    try {
      await this.makeRequest("GET", "/objectschema/list");
      return true;
    } catch (error) {
      console.error(
        `  [Cloud Assets] Connection test failed: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Find a single object by its objectKey using AQL
   * @param {string} objectKey - e.g. "ASSET-123"
   * @returns {object|null} - Object with {id, objectKey, globalId} or null
   */
  async findObjectByKey(objectKey) {
    // Check cache first
    if (this.objectCache.has(objectKey)) {
      return this.objectCache.get(objectKey);
    }

    try {
      const escaped = CloudAssetsClient.escapeAqlValue(objectKey);
      const response = await this.makeRequest("POST", "/object/aql", {
        qlQuery: `Key = "${escaped}"`,
      });

      const objects = response.values || [];
      if (objects.length === 0) return null;

      const obj = objects[0];
      const result = {
        id: String(obj.id),
        objectKey: obj.objectKey,
        globalId: obj.globalId || `${this.workspaceId}:${obj.id}`,
        name: obj.label || obj.name || null,
      };

      this.objectCache.set(objectKey, result);
      return result;
    } catch (error) {
      console.error(
        `  [Assets] Failed to find object ${objectKey}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Find multiple objects by their objectKeys using batch AQL.
   * Uses IN clause for efficiency. Batches in groups of 25.
   *
   * @param {string[]} objectKeys - Array of object keys
   * @returns {Map<string, {id, objectKey, globalId}>}
   */
  async findObjectsByKeys(objectKeys) {
    const results = new Map();

    if (!objectKeys || objectKeys.length === 0) return results;

    // Separate cached and uncached keys
    const uncachedKeys = [];
    for (const key of objectKeys) {
      if (this.objectCache.has(key)) {
        results.set(key, this.objectCache.get(key));
      } else {
        uncachedKeys.push(key);
      }
    }

    if (uncachedKeys.length === 0) return results;

    // Batch AQL in groups of 25
    const batchSize = 25;
    const totalBatches = Math.ceil(uncachedKeys.length / batchSize);
    for (let i = 0; i < uncachedKeys.length; i += batchSize) {
      const batchNum = Math.floor(i / batchSize) + 1;
      const batch = uncachedKeys.slice(i, i + batchSize);
      if (totalBatches > 1) {
        console.log(`  [Assets] Resolving keys batch ${batchNum}/${totalBatches} (${batch.length} keys)`);
      }
      const quotedKeys = batch
        .map((k) => `"${CloudAssetsClient.escapeAqlValue(k)}"`)
        .join(", ");
      const aql = `Key IN (${quotedKeys})`;

      try {
        // Paginate through results
        let startAt = 0;
        const maxResults = 50;

        while (true) {
          const response = await this.makeRequest(
            "POST",
            `/object/aql?startAt=${startAt}&maxResults=${maxResults}&includeAttributes=false`,
            { qlQuery: aql },
          );

          const objects = response.values || [];
          for (const obj of objects) {
            const resolved = {
              id: String(obj.id),
              objectKey: obj.objectKey,
              globalId: obj.globalId || `${this.workspaceId}:${obj.id}`,
              name: obj.label || obj.name || null,
            };
            results.set(obj.objectKey, resolved);
            this.objectCache.set(obj.objectKey, resolved);
          }

          if (response.isLast || objects.length === 0) break;
          startAt += objects.length;
        }
      } catch (error) {
        console.error(
          `  [Assets] Batch AQL failed for ${batch.length} keys: ${error.message}`,
        );
      }
    }

    return results;
  }

  /**
   * Fetch a single object by its numeric ID, with caching.
   * @param {string} objectId - e.g. "15004"
   * @returns {object|null} - {id, objectKey, globalId, name} or null
   */
  async getObjectById(objectId) {
    const cacheKey = `_byId:${objectId}`;
    if (this.objectCache.has(cacheKey)) {
      return this.objectCache.get(cacheKey);
    }

    try {
      const obj = await this.makeRequest("GET", `/object/${objectId}`);
      const result = {
        id: String(obj.id),
        objectKey: obj.objectKey,
        globalId: obj.globalId || `${this.workspaceId}:${obj.id}`,
        name: obj.label || obj.name || null,
      };
      this.objectCache.set(cacheKey, result);
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Find a single object by its name using AQL.
   * @param {string} name - e.g. "Rate Publisher"
   * @returns {object|null} - {id, objectKey, globalId, name} or null
   */
  async findObjectByName(name) {
    if (!name) return null;

    const cacheKey = `_byName:${name.toLowerCase().trim()}`;
    if (this.objectCache.has(cacheKey)) {
      return this.objectCache.get(cacheKey);
    }

    try {
      const escaped = CloudAssetsClient.escapeAqlValue(name);
      const response = await this.makeRequest("POST", "/object/aql", {
        qlQuery: `Name = "${escaped}"`,
      });

      const objects = response.values || [];
      if (objects.length === 0) return null;

      if (objects.length > 1) {
        console.log(
          `  [Assets] WARNING: ${objects.length} objects found for name "${name}", using first match (${objects[0].objectKey})`,
        );
      }

      const obj = objects[0];
      const result = {
        id: String(obj.id),
        objectKey: obj.objectKey,
        globalId: obj.globalId || `${this.workspaceId}:${obj.id}`,
        name: obj.label || obj.name || null,
        resolvedBy: "name",
      };

      this.objectCache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.error(
        `  [Assets] Failed to find object by name "${name}": ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Find multiple objects by their names using batch AQL.
   * Uses Name IN clause for efficiency. Batches in groups of 25.
   *
   * @param {string[]} names - Array of asset names
   * @returns {Map<string, {id, objectKey, globalId, name, resolvedBy}>} keyed by lowercase name
   */
  async findObjectsByNames(names) {
    const results = new Map();

    if (!names || names.length === 0) return results;

    // Deduplicate and normalize
    const uniqueNames = [...new Set(names.map((n) => n.trim()).filter(Boolean))];

    // Separate cached and uncached
    const uncachedNames = [];
    for (const name of uniqueNames) {
      const cacheKey = `_byName:${name.toLowerCase()}`;
      if (this.objectCache.has(cacheKey)) {
        results.set(name.toLowerCase(), this.objectCache.get(cacheKey));
      } else {
        uncachedNames.push(name);
      }
    }

    if (uncachedNames.length === 0) return results;

    // Batch AQL in groups of 25
    const batchSize = 25;
    const totalBatches = Math.ceil(uncachedNames.length / batchSize);
    for (let i = 0; i < uncachedNames.length; i += batchSize) {
      const batchNum = Math.floor(i / batchSize) + 1;
      const batch = uncachedNames.slice(i, i + batchSize);
      if (totalBatches > 1) {
        console.log(`  [Assets] Resolving names batch ${batchNum}/${totalBatches} (${batch.length} names)`);
      }
      const quotedNames = batch
        .map((n) => `"${CloudAssetsClient.escapeAqlValue(n)}"`)
        .join(", ");
      const aql = `Name IN (${quotedNames})`;

      try {
        let startAt = 0;
        const maxResults = 50;

        while (true) {
          const response = await this.makeRequest(
            "POST",
            `/object/aql?startAt=${startAt}&maxResults=${maxResults}&includeAttributes=false`,
            { qlQuery: aql },
          );

          const objects = response.values || [];
          for (const obj of objects) {
            const objName = obj.label || obj.name || null;
            if (!objName) continue;

            const resolved = {
              id: String(obj.id),
              objectKey: obj.objectKey,
              globalId: obj.globalId || `${this.workspaceId}:${obj.id}`,
              name: objName,
              resolvedBy: "name",
            };

            const lowerName = objName.toLowerCase().trim();
            // Only store first match per name (warn on duplicates)
            if (!results.has(lowerName)) {
              results.set(lowerName, resolved);
              this.objectCache.set(`_byName:${lowerName}`, resolved);
            }
          }

          if (response.isLast || objects.length === 0) break;
          startAt += objects.length;
        }
      } catch (error) {
        console.error(
          `  [Assets] Batch name AQL failed for ${batch.length} names: ${error.message}`,
        );
      }
    }

    return results;
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      cacheSize: this.objectCache.size,
    };
  }
}

module.exports = CloudAssetsClient;
