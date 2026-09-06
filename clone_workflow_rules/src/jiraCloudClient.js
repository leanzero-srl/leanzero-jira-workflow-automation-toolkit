const https = require("https");
const { URL } = require("url");

class JiraCloudClient {
  constructor(baseUrl, apiToken) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.hostname = parsed.hostname;
    this.apiToken = apiToken;
    this.requestCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;

    this._projectCache = new Map();
    this._fieldCache = new Map();
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };
    const maxRateLimitRetries = 3;
    const maxServerRetries = 3;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: 443,
        path,
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

          if (res.statusCode === 429) {
            this.rateLimitCount++;
            if (state.rateLimitAttempts >= maxRateLimitRetries) {
              const error = new Error(
                `Cloud API rate limit exceeded after ${maxRateLimitRetries} attempts: ${method} ${path}`,
              );
              error.statusCode = 429;
              error.isRateLimit = true;
              reject(error);
              return;
            }
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 60000);
            console.log(
              `  [Cloud] Rate limited (429), waiting ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`,
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
              `  [Cloud] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`,
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

          if (res.statusCode === 204) {
            resolve(null);
            return;
          }

          if (res.statusCode >= 400) {
            this.errorCount++;
            const error = new Error(
              `Cloud API ${method} ${path} returned ${res.statusCode}: ${data.substring(0, 500)}`,
            );
            error.statusCode = res.statusCode;
            error.responseBody = data;
            reject(error);
            return;
          }

          try {
            resolve(data ? JSON.parse(data) : null);
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
            `  [Cloud] Connection error: ${err.message}, retrying in ${delay / 1000}s`,
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
            `  [Cloud] Request timeout, retrying in ${delay / 1000}s`,
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
        reject(new Error(`Cloud API request timeout: ${method} ${path}`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async testConnection() {
    try {
      const info = await this.makeRequest("GET", "/rest/api/3/serverInfo");
      return info;
    } catch (error) {
      console.error(`  [Cloud] Connection test failed: ${error.message}`);
      return null;
    }
  }

  // ─────────────────────────────────────────────────
  //  PROJECT LOOKUP
  // ─────────────────────────────────────────────────

  async getProjectByKey(projectKey) {
    if (this._projectCache.has(projectKey)) {
      return this._projectCache.get(projectKey);
    }
    try {
      const project = await this.makeRequest(
        "GET",
        `/rest/api/3/project/${encodeURIComponent(projectKey)}`,
      );
      const entry = { id: String(project.id), key: project.key, name: project.name };
      this._projectCache.set(projectKey, entry);
      return entry;
    } catch (error) {
      if (error.statusCode === 404) {
        this._projectCache.set(projectKey, null);
        return null;
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────
  //  WORKFLOW RETRIEVAL
  // ─────────────────────────────────────────────────

  async getWorkflowByName(workflowName) {
    const encoded = encodeURIComponent(workflowName);
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/workflow/search?workflowName=${encoded}&expand=transitions.rules,operations,statuses.properties,transitions.properties`,
    );
    if (res.values && res.values.length > 0) {
      return res.values[0];
    }
    return null;
  }

  async getAllWorkflows() {
    // Paginate /rest/api/3/workflow/search with no filter to enumerate every workflow
    // on the instance. Returns the bare values[] array (shape matches getWorkflowByName).
    const all = [];
    let startAt = 0;
    const maxResults = 50;
    while (true) {
      const res = await this.searchWorkflows(null, startAt, maxResults);
      const values = res.values || [];
      all.push(...values);
      if (res.isLast || values.length === 0) break;
      if (startAt + values.length >= (res.total || values.length)) break;
      startAt += values.length;
    }
    return all;
  }

  async searchWorkflows(queryString, startAt = 0, maxResults = 50) {
    const params = new URLSearchParams({
      startAt: String(startAt),
      maxResults: String(maxResults),
      expand: "transitions.rules,statuses.properties,transitions.properties",
    });
    if (queryString) {
      params.set("queryString", queryString);
    }
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/workflow/search?${params.toString()}`,
    );
    return res;
  }

  // ─────────────────────────────────────────────────
  //  WORKFLOW CREATION
  // ─────────────────────────────────────────────────

  async createWorkflow(payload) {
    return this.makeRequest("POST", "/rest/api/3/workflow/", payload);
  }

  async createWorkflowsBulk(payload) {
    return this.makeRequest("POST", "/rest/api/3/workflows/create", payload);
  }

  async validateCreateWorkflowsBulk(payload) {
    return this.makeRequest(
      "POST",
      "/rest/api/3/workflows/create/validation",
      { payload },
    );
  }

  // ─────────────────────────────────────────────────
  //  WORKFLOW UPDATE (in-place bulk update)
  //  Uses the newer unified workflow API. Keyed by workflow UUID + version
  //  (optimistic concurrency). If another admin edits between lookup and update,
  //  the API returns 409 and we re-fetch.
  // ─────────────────────────────────────────────────

  /**
   * Bulk lookup workflows by name. Returns the new-shape workflow objects including
   * `id` (UUID) and `version: {id, versionNumber}` — both required for updates.
   * POST body: { workflowNames: [...] } (up to 50 per call).
   */
  async getWorkflowsByNames(names) {
    if (!names || names.length === 0) return [];
    const chunkSize = 50;
    const all = [];
    for (let i = 0; i < names.length; i += chunkSize) {
      const chunk = names.slice(i, i + chunkSize);
      const res = await this.makeRequest("POST", "/rest/api/3/workflows", {
        workflowNames: chunk,
      });
      if (res && Array.isArray(res.workflows)) {
        all.push(...res.workflows);
      }
    }
    return all;
  }

  /**
   * Like getWorkflowsByNames, but returns the FULL read envelope `{ workflows, statuses }`.
   * The top-level `statuses` array carries the status details (id, name, statusCategory)
   * that each workflow's `statuses[].statusReference` points at — needed to build a
   * status catalog and to construct create/update payloads. getWorkflowsByNames discards it.
   * POST body: { workflowNames: [...] } (chunked to 50). Returns { workflows: [...], statuses: [...] }.
   */
  async getWorkflowsEnvelopeByNames(names) {
    const out = { workflows: [], statuses: [] };
    if (!names || names.length === 0) return out;
    const chunkSize = 50;
    for (let i = 0; i < names.length; i += chunkSize) {
      const chunk = names.slice(i, i + chunkSize);
      const res = await this.makeRequest("POST", "/rest/api/3/workflows", {
        workflowNames: chunk,
      });
      if (res && Array.isArray(res.workflows)) out.workflows.push(...res.workflows);
      if (res && Array.isArray(res.statuses)) out.statuses.push(...res.statuses);
    }
    return out;
  }

  async updateWorkflowsBulk(payload) {
    return this.makeRequest("POST", "/rest/api/3/workflows/update", payload);
  }

  async validateUpdateWorkflowsBulk(payload) {
    return this.makeRequest(
      "POST",
      "/rest/api/3/workflows/update/validation",
      { payload },
    );
  }

  // ─────────────────────────────────────────────────
  //  WORKFLOW SCHEME MANAGEMENT
  // ─────────────────────────────────────────────────

  async getWorkflowSchemeForProject(projectId) {
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/workflowscheme/project?projectId=${encodeURIComponent(projectId)}`,
    );
    if (res.values && res.values.length > 0) {
      return res.values[0].workflowScheme;
    }
    return null;
  }

  async updateWorkflowSchemeDefault(schemeId, workflowName) {
    return this.makeRequest(
      "PUT",
      `/rest/api/3/workflowscheme/${encodeURIComponent(schemeId)}/default`,
      {
        workflow: workflowName,
        updateDraftIfNeeded: true,
      },
    );
  }

  async updateWorkflowScheme(schemeId, payload) {
    payload.updateDraftIfNeeded = true;
    return this.makeRequest(
      "PUT",
      `/rest/api/3/workflowscheme/${encodeURIComponent(schemeId)}`,
      payload,
    );
  }

  async publishWorkflowSchemeDraft(schemeId) {
    return this.makeRequest(
      "POST",
      `/rest/api/3/workflowscheme/${encodeURIComponent(schemeId)}/draft/publish`,
      {},
    );
  }

  async pollTask(taskUrl, intervalMs = 10000, maxWaitMs = 300000) {
    const start = Date.now();
    // Extract path from full URL if needed
    let taskPath = taskUrl;
    if (taskUrl.startsWith("http")) {
      const parsed = new URL(taskUrl);
      taskPath = parsed.pathname;
    }

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const res = await this.makeRequest("GET", taskPath);
      if (res.status === "COMPLETE" || res.status === "DONE") {
        return res;
      }
      if (
        res.status === "FAILED" ||
        res.status === "CANCEL_REQUESTED" ||
        res.status === "CANCELLED"
      ) {
        throw new Error(
          `Task failed: ${res.status} - ${JSON.stringify(res.result || res.error || "")}`,
        );
      }
      if (res.progress !== undefined) {
        console.log(`  [Cloud] Publishing progress: ${res.progress}%`);
      }
    }
    throw new Error(`Task did not complete within ${maxWaitMs / 1000}s`);
  }

  // ─────────────────────────────────────────────────
  //  FIELD LOOKUP
  // ─────────────────────────────────────────────────

  async getFieldById(fieldId) {
    if (this._fieldCache.has(fieldId)) {
      return this._fieldCache.get(fieldId);
    }
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/field/search?id=${encodeURIComponent(fieldId)}`,
    );
    if (res.values && res.values.length > 0) {
      const field = res.values[0];
      this._fieldCache.set(fieldId, field);
      return field;
    }
    return null;
  }

  async searchFieldByName(name) {
    const encoded = encodeURIComponent(name);
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/field/search?query=${encoded}`,
    );
    return res.values || [];
  }

  // ─────────────────────────────────────────────────
  //  STATUS LOOKUP
  // ─────────────────────────────────────────────────

  async getAllStatuses() {
    const statuses = [];
    let startAt = 0;
    const maxResults = 200;

    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/statuses/search?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const values = res.values || [];
      statuses.push(...values);
      if (startAt + values.length >= (res.total || values.length)) break;
      if (values.length === 0) break;
      startAt += values.length;
    }

    return statuses;
  }

  // ─────────────────────────────────────────────────
  //  WORKFLOW CAPABILITIES
  // ─────────────────────────────────────────────────

  async getWorkflowCapabilities(workflowId) {
    const params = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : "";
    return this.makeRequest("GET", `/rest/api/3/workflows/capabilities${params}`);
  }

  // ─────────────────────────────────────────────────
  //  ENTITY CATALOGS (for ID remapping across instances)
  //
  //  Shape conventions verified against developer.atlassian.com v3:
  //    bare array:     /issuetype, /role, /events, /resolution, /priority (legacy)
  //    paginated:      /screens, /priority/search, /resolution/search, /group/bulk,
  //                    /statuses/search
  //    wrapped:        /issueLinkType -> { issueLinkTypes: [...] }
  //                    /issuesecurityschemes -> { issueSecuritySchemes: [...] }
  //  There is no single-resource GET /screens/{id}; use /screens?id=N instead.
  // ─────────────────────────────────────────────────

  async getAllIssueTypes() {
    return this.makeRequest("GET", "/rest/api/3/issuetype");
  }

  async getAllScreens() {
    const all = [];
    let startAt = 0;
    const maxResults = 100;
    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/screens?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const values = res.values || [];
      all.push(...values);
      if (res.isLast || values.length === 0) break;
      if (startAt + values.length >= (res.total || values.length)) break;
      startAt += values.length;
    }
    return all;
  }

  async getScreenById(screenId) {
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/screens?id=${encodeURIComponent(screenId)}`,
    );
    const values = res.values || [];
    return values[0] || null;
  }

  async getAllProjectRoles() {
    return this.makeRequest("GET", "/rest/api/3/role");
  }

  async getAllPriorities() {
    const all = [];
    let startAt = 0;
    const maxResults = 100;
    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/priority/search?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const values = res.values || [];
      all.push(...values);
      if (res.isLast || values.length === 0) break;
      if (startAt + values.length >= (res.total || values.length)) break;
      startAt += values.length;
    }
    return all;
  }

  async getAllResolutions() {
    const all = [];
    let startAt = 0;
    const maxResults = 100;
    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/resolution/search?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const values = res.values || [];
      all.push(...values);
      if (res.isLast || values.length === 0) break;
      if (startAt + values.length >= (res.total || values.length)) break;
      startAt += values.length;
    }
    return all;
  }

  async getAllIssueLinkTypes() {
    const res = await this.makeRequest("GET", "/rest/api/3/issueLinkType");
    return res.issueLinkTypes || [];
  }

  async getAllEvents() {
    return this.makeRequest("GET", "/rest/api/3/events");
  }

  async getAllSecuritySchemes() {
    const res = await this.makeRequest("GET", "/rest/api/3/issuesecurityschemes");
    return res.issueSecuritySchemes || [];
  }

  async getSecuritySchemeById(schemeId) {
    return this.makeRequest(
      "GET",
      `/rest/api/3/issuesecurityschemes/${encodeURIComponent(schemeId)}`,
    );
  }

  async getGroupsByName(groupName) {
    // Post-GDPR: /group/bulk accepts groupName (repeatable) and returns {groupId, name}.
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/group/bulk?groupName=${encodeURIComponent(groupName)}`,
    );
    return res.values || [];
  }

  async getAllWorkflowSchemes() {
    const all = [];
    let startAt = 0;
    const maxResults = 50;
    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/workflowscheme?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const values = res.values || [];
      all.push(...values);
      if (res.isLast || values.length === 0) break;
      if (startAt + values.length >= (res.total || values.length)) break;
      startAt += values.length;
    }
    return all;
  }

  // ─────────────────────────────────────────────────
  //  STATS
  // ─────────────────────────────────────────────────

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      rateLimitCount: this.rateLimitCount,
    };
  }
}

module.exports = JiraCloudClient;
