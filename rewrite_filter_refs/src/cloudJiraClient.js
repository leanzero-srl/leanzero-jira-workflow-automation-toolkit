const https = require("https");
const http = require("http");
const { URL } = require("url");

class CloudJiraClient {
  constructor(baseUrl, apiToken, log) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiToken = apiToken;
    this.log = log || console.log;
    this.requestCount = 0;
    this.errorCount = 0;
    this.rateLimitCount = 0;
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };

    return new Promise((resolve, reject) => {
      const fullUrl = `${this.baseUrl}${path}`;
      const parsed = new URL(fullUrl);
      const client = parsed.protocol === "https:" ? https : http;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          Authorization: `Basic ${this.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 30000,
      };

      const req = client.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 204) {
            return resolve({ statusCode: 204, body: null });
          }

          if (res.statusCode === 429) {
            this.rateLimitCount++;
            if (state.rateLimitAttempts < 3) {
              const retryAfter = res.headers["retry-after"];
              const delays = [5000, 10000, 20000];
              const delay = retryAfter
                ? parseInt(retryAfter, 10) * 1000
                : delays[state.rateLimitAttempts] || 20000;
              this.log(
                `  Rate limited on ${method} ${path}, retry ${state.rateLimitAttempts + 1}/3 in ${delay / 1000}s`
              );
              state.rateLimitAttempts++;
              return setTimeout(() => {
                this.makeRequest(method, path, body, state)
                  .then(resolve)
                  .catch(reject);
              }, delay);
            }
            this.errorCount++;
            const err = new Error(
              `Rate limit exceeded after 3 retries: ${method} ${path}`
            );
            err.statusCode = 429;
            return reject(err);
          }

          if (res.statusCode >= 500) {
            if (state.serverErrorAttempts < 3) {
              const delay = Math.min(
                1000 * Math.pow(2, state.serverErrorAttempts),
                10000
              );
              this.log(
                `  Server error ${res.statusCode} on ${method} ${path}, retry ${state.serverErrorAttempts + 1}/3 in ${delay / 1000}s`
              );
              state.serverErrorAttempts++;
              return setTimeout(() => {
                this.makeRequest(method, path, body, state)
                  .then(resolve)
                  .catch(reject);
              }, delay);
            }
            this.errorCount++;
            const err = new Error(
              `Server error ${res.statusCode} after 3 retries: ${method} ${path} - ${data}`
            );
            err.statusCode = res.statusCode;
            return reject(err);
          }

          if (res.statusCode >= 400) {
            this.errorCount++;
            const err = new Error(
              `HTTP ${res.statusCode}: ${method} ${path} - ${data}`
            );
            err.statusCode = res.statusCode;
            err.responseBody = data;
            return reject(err);
          }

          try {
            const parsed = data ? JSON.parse(data) : null;
            resolve({ statusCode: res.statusCode, body: parsed });
          } catch (e) {
            resolve({ statusCode: res.statusCode, body: data });
          }
        });
      });

      req.on("error", (err) => {
        if (state.serverErrorAttempts < 3) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          this.log(
            `  Connection error on ${method} ${path}: ${err.message}, retry ${state.serverErrorAttempts + 1}/3 in ${delay / 1000}s`
          );
          state.serverErrorAttempts++;
          return setTimeout(() => {
            this.makeRequest(method, path, body, state)
              .then(resolve)
              .catch(reject);
          }, delay);
        }
        this.errorCount++;
        reject(
          new Error(
            `Connection failed after 3 retries: ${method} ${path} - ${err.message}`
          )
        );
      });

      req.on("timeout", () => {
        req.destroy();
        if (state.serverErrorAttempts < 3) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          this.log(
            `  Timeout on ${method} ${path}, retry ${state.serverErrorAttempts + 1}/3 in ${delay / 1000}s`
          );
          state.serverErrorAttempts++;
          return setTimeout(() => {
            this.makeRequest(method, path, body, state)
              .then(resolve)
              .catch(reject);
          }, delay);
        }
        this.errorCount++;
        reject(new Error(`Request timeout after 3 retries: ${method} ${path}`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async testConnection() {
    const res = await this.makeRequest("GET", "/rest/api/3/serverInfo");
    return res.body;
  }

  async getCurrentUser() {
    const res = await this.makeRequest("GET", "/rest/api/3/myself");
    return res.body;
  }

  // GET /rest/api/3/filter/search  (paginated)
  //
  // overrideSharePermissions=true is critical for admin migration runs: without
  // it Cloud returns only filters visible to the caller by share-permission.
  // With it (admin global perm required), Cloud returns ALL filters on the
  // tenant — roughly 2x our count on this tenant (53,828 vs 30,039). See
  // https://support.atlassian.com/jira/kb/bulk-change-of-filter-owners-in-jira-cloud/
  async searchAllFilters({ expand = "jql,owner,description", limit = 0 } = {}) {
    const filters = [];
    let startAt = 0;
    const maxResults = 50;
    const expandParam = expand
      ? `&expand=${encodeURIComponent(expand)}`
      : "";

    while (true) {
      // Cloud's PostgreSQL backing /filter/search occasionally throws a
      // PSQLException on the count(*) query when overrideSharePermissions is
      // on. The same page retries fine — wrap with a small retry loop so a
      // 3-hour rebuild isn't wasted by a single transient DB hiccup.
      let res;
      let pageAttempt = 0;
      const maxPageAttempts = 5;
      while (true) {
        try {
          res = await this.makeRequest(
            "GET",
            `/rest/api/3/filter/search?overrideSharePermissions=true&startAt=${startAt}&maxResults=${maxResults}${expandParam}`,
          );
          break;
        } catch (err) {
          const body = String(err.responseBody || err.message || "");
          const isPsql = err.statusCode === 400 && /PSQLException/i.test(body);
          if (!isPsql || pageAttempt >= maxPageAttempts - 1) throw err;
          pageAttempt++;
          const wait = 2000 * pageAttempt;
          this.log(
            `  searchAllFilters: PSQLException at startAt=${startAt}, retry ${pageAttempt}/${maxPageAttempts} after ${wait}ms`,
          );
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      const page = res.body || {};
      const values = page.values || [];
      filters.push(...values);

      if (limit > 0 && filters.length >= limit) {
        return filters.slice(0, limit);
      }
      if (page.isLast === true) break;
      if (values.length === 0) break;
      if (page.total != null && startAt + values.length >= page.total) break;
      startAt += values.length;
    }

    return filters;
  }

  // GET /rest/api/3/filter/{id}
  // overrideSharePermissions=true lets the admin GET filters they can't see
  // by share-permission. Necessary when the plan includes filters surfaced
  // by the admin-search but otherwise inaccessible.
  async getFilter(
    id,
    { expand = "jql,owner,description,sharePermissions,editPermissions" } = {}
  ) {
    const params = ["overrideSharePermissions=true"];
    if (expand) params.push(`expand=${encodeURIComponent(expand)}`);
    const qs = `?${params.join("&")}`;
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/filter/${encodeURIComponent(id)}${qs}`
    );
    return res.body;
  }

  // GET /rest/api/3/filter/search?filterName=...&isSubstringMatch=false
  async searchFilterByName(name) {
    const results = [];
    let startAt = 0;
    const maxResults = 50;
    const nameParam = `filterName=${encodeURIComponent(name)}`;

    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/filter/search?${nameParam}&isSubstringMatch=false&startAt=${startAt}&maxResults=${maxResults}&expand=owner`
      );
      const page = res.body || {};
      const values = page.values || [];
      results.push(...values);

      if (page.isLast === true) break;
      if (values.length === 0) break;
      if (page.total != null && startAt + values.length >= page.total) break;
      startAt += values.length;
    }

    return results;
  }

  // PUT /rest/api/3/filter/{id}
  async updateFilter(
    id,
    { name, jql, description, sharePermissions, editPermissions } = {}
  ) {
    const body = {};
    if (name !== undefined) body.name = name;
    if (jql !== undefined) body.jql = jql;
    if (description !== undefined) body.description = description;
    if (sharePermissions !== undefined) body.sharePermissions = sharePermissions;
    if (editPermissions !== undefined) body.editPermissions = editPermissions;
    // overrideSharePermissions=true is the documented admin path for
    // bulk update of filters the caller doesn't own or share with.
    const res = await this.makeRequest(
      "PUT",
      `/rest/api/3/filter/${encodeURIComponent(id)}?overrideSharePermissions=true`,
      body
    );
    return res.body;
  }

  // PUT /rest/api/3/filter/{id}/owner
  async setFilterOwner(id, accountId) {
    const res = await this.makeRequest(
      "PUT",
      `/rest/api/3/filter/${encodeURIComponent(id)}/owner?overrideSharePermissions=true`,
      { accountId }
    );
    return res.body;
  }

  // GET /rest/api/3/project/search — paginated list of all visible projects.
  // Returns the bare values array; callers index by key/name.
  async getAllProjects() {
    const projects = [];
    let startAt = 0;
    const maxResults = 50;
    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}`,
      );
      const page = res.body || {};
      const values = page.values || [];
      projects.push(...values);
      if (page.isLast === true) break;
      if (values.length === 0) break;
      if (page.total != null && startAt + values.length >= page.total) break;
      startAt += values.length;
    }
    return projects;
  }

  // GET /rest/api/3/field/search — paginated list of all custom fields.
  // expand=key surfaces the legacy id form ("customfield_NNN") alongside the
  // numeric customId in `schema.customId`. We page until isLast or empty,
  // mirroring the convention used in sync_asset_ticket_associations.
  async getAllFields() {
    const fields = [];
    let startAt = 0;
    const maxResults = 100;
    while (true) {
      const res = await this.makeRequest(
        "GET",
        `/rest/api/3/field/search?type=custom&startAt=${startAt}&maxResults=${maxResults}&expand=key`,
      );
      const page = res.body || {};
      const values = page.values || [];
      fields.push(...values);
      if (page.isLast === true) break;
      if (values.length === 0) break;
      if (page.total != null && startAt + values.length >= page.total) break;
      startAt += values.length;
    }
    return fields;
  }

  // GET /rest/api/3/priority/search — paginated list of all issue priorities.
  // We page until isLast or empty. Falls back to the deprecated flat-array
  // endpoint /rest/api/3/priority on 404/405 for older Cloud tenants. Returns
  // an array of { id, name, description, statusColor, ... } objects.
  async getAllPriorities() {
    const out = [];
    let startAt = 0;
    const maxResults = 100;
    try {
      while (true) {
        const res = await this.makeRequest(
          "GET",
          `/rest/api/3/priority/search?startAt=${startAt}&maxResults=${maxResults}`,
        );
        const page = res.body || {};
        const values = page.values || [];
        out.push(...values);
        if (page.isLast === true) break;
        if (values.length === 0) break;
        if (page.total != null && startAt + values.length >= page.total) break;
        startAt += values.length;
      }
    } catch (err) {
      if (
        out.length === 0 &&
        (err.statusCode === 404 || err.statusCode === 405)
      ) {
        const res = await this.makeRequest("GET", "/rest/api/3/priority");
        return Array.isArray(res.body) ? res.body : [];
      }
      throw err;
    }
    return out;
  }

  // POST /rest/api/3/filter/{id}/permission — adds ONE share permission entry
  // to an existing filter. This is the ONLY working way to add a share
  // permission on Cloud: PUT /filter/{id} silently drops sharePermissions
  // updates (the PUT returns 200 OK but Cloud doesn't persist them). See
  // https://community.atlassian.com/forums/Jira-questions/Updating-Share-Permissions-using-PUT-rest-api-2-filter-id-does/qaq-p/2189785
  //
  // body shape (one of):
  //   { type: "group",       groupId: "<gid>" }
  //   { type: "group",       groupname: "<name>" }       (deprecated alias)
  //   { type: "project",     projectId: "<pid>" }
  //   { type: "projectRole", projectId: "<pid>", projectRoleId: "<rid>" }
  //   { type: "user",        accountId: "<aid>" }
  //   { type: "global" }     (logged-in or anyone)
  //   { type: "authenticated" }
  async addFilterSharePermission(filterId, body) {
    const res = await this.makeRequest(
      "POST",
      `/rest/api/3/filter/${encodeURIComponent(filterId)}/permission?overrideSharePermissions=true`,
      body,
    );
    return res.body;
  }

  // GET /rest/api/3/filter/{id}/permission — list existing share permissions
  // with their numeric ids (needed for DELETE).
  async getFilterPermissions(filterId) {
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/filter/${encodeURIComponent(filterId)}/permission`,
    );
    return res.body;
  }

  // DELETE /rest/api/3/filter/{id}/permission/{permissionId}
  async deleteFilterPermission(filterId, permissionId) {
    const res = await this.makeRequest(
      "DELETE",
      `/rest/api/3/filter/${encodeURIComponent(filterId)}/permission/${encodeURIComponent(permissionId)}`,
    );
    return res.body;
  }

  // GET /rest/api/3/groups/picker?query=<name> — resolves a group by name to
  // { groupId, name } (Cloud GDPR tenants expose groupId; return null if no
  // exact match exists).
  async pickGroup(name) {
    const q = encodeURIComponent(name);
    const res = await this.makeRequest(
      "GET",
      `/rest/api/3/groups/picker?query=${q}&maxResults=50`
    );
    const body = res.body || {};
    const groups = body.groups || [];
    const match = groups.find(
      (g) => (g.name || "").toLowerCase() === name.toLowerCase()
    );
    if (!match) return null;
    return { groupId: match.groupId || null, name: match.name };
  }

  // POST /rest/api/3/group/user?groupId=<gid> — add an account to a group.
  // Used by join_share_groups.js so the caller can share filters that are also
  // shared with otherwise-restricted groups (e.g. "Reporting Group").
  async addUserToGroup(groupId, accountId) {
    const res = await this.makeRequest(
      "POST",
      `/rest/api/3/group/user?groupId=${encodeURIComponent(groupId)}`,
      { accountId },
    );
    return res.body;
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      rateLimitCount: this.rateLimitCount,
    };
  }
}

module.exports = CloudJiraClient;
