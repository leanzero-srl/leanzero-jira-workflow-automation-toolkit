const https = require("https");
const http = require("http");
const { URL } = require("url");

class JiraDcClient {
  constructor(baseUrl, auth) {
    if (!baseUrl) throw new Error("JiraDcClient: baseUrl is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.protocol = parsed.protocol === "https:" ? https : http;
    this.hostname = parsed.hostname;
    this.port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    this.basePath = parsed.pathname.replace(/\/$/, "");

    const authType = (auth && auth.authType) || "bearer";
    if (authType === "bearer") {
      if (!auth.token) throw new Error("JiraDcClient: bearer auth requires token");
      this.authHeader = `Bearer ${auth.token}`;
    } else if (authType === "basic") {
      if (!auth.username || !auth.password) {
        throw new Error("JiraDcClient: basic auth requires username and password");
      }
      this.authHeader = "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
    } else {
      throw new Error(`JiraDcClient: unknown authType "${authType}"`);
    }

    this.requestCount = 0;
    this.errorCount = 0;
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || { rateLimitAttempts: 0, serverErrorAttempts: 0 };
    const maxRateLimitRetries = 5;
    const maxServerRetries = 3;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.hostname,
        port: this.port,
        path: this.basePath + path,
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 30000,
      };

      let bodyStr = null;
      if (body) {
        bodyStr = JSON.stringify(body);
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const retry = (newState) =>
        this.makeRequest(method, path, body, newState).then(resolve).catch(reject);

      const req = this.protocol.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          this.requestCount++;

          if (res.statusCode === 429 && state.rateLimitAttempts < maxRateLimitRetries) {
            const retryAfter = res.headers["retry-after"];
            const delay = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : Math.min(5000 * Math.pow(2, state.rateLimitAttempts), 120000);
            console.log(
              `  [DC] Rate limited (429), retrying in ${delay / 1000}s (attempt ${
                state.rateLimitAttempts + 1
              }/${maxRateLimitRetries})`,
            );
            setTimeout(
              () => retry({ ...state, rateLimitAttempts: state.rateLimitAttempts + 1 }),
              delay,
            );
            return;
          }

          if (
            res.statusCode >= 500 &&
            res.statusCode < 600 &&
            state.serverErrorAttempts < maxServerRetries
          ) {
            const delay = Math.min(1000 * Math.pow(2, state.serverErrorAttempts), 10000);
            console.log(
              `  [DC] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${
                state.serverErrorAttempts + 1
              }/${maxServerRetries})`,
            );
            setTimeout(
              () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
              delay,
            );
            return;
          }

          if (res.statusCode >= 400) {
            this.errorCount++;
            const error = new Error(
              `DC API ${method} ${path} returned ${res.statusCode}: ${data.substring(0, 500)}`,
            );
            error.statusCode = res.statusCode;
            reject(error);
            return;
          }

          if (!data) {
            resolve(null);
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
          console.log(`  [DC] Connection error: ${err.message}, retrying in ${delay / 1000}s`);
          setTimeout(
            () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
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
          console.log(`  [DC] Request timeout, retrying in ${delay / 1000}s`);
          setTimeout(
            () => retry({ ...state, serverErrorAttempts: state.serverErrorAttempts + 1 }),
            delay,
          );
          return;
        }
        reject(new Error(`DC API request timeout: ${method} ${path}`));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async testConnection() {
    try {
      const info = await this.makeRequest("GET", "/rest/api/2/serverInfo");
      return { ok: true, info };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async getAllWorkflows() {
    return this.makeRequest("GET", "/rest/api/2/workflow");
  }

  async getWorkflowByName(name) {
    const all = await this.makeRequest(
      "GET",
      `/rest/api/2/workflow?workflowName=${encodeURIComponent(name)}`,
    );
    if (Array.isArray(all) && all.length > 0) return all[0];
    return null;
  }

  async getWorkflowSchemeForProject(projectKeyOrId) {
    try {
      return await this.makeRequest(
        "GET",
        `/rest/api/2/project/${encodeURIComponent(projectKeyOrId)}/workflowscheme`,
      );
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  async getWorkflowScheme(schemeId) {
    return this.makeRequest(
      "GET",
      `/rest/api/2/workflowscheme/${encodeURIComponent(schemeId)}`,
    );
  }

  async getProjectKeys(projectKeyOrId) {
    try {
      return await this.makeRequest(
        "GET",
        `/rest/api/2/project/${encodeURIComponent(projectKeyOrId)}`,
      );
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  /**
   * Returns all visible fields on this DC instance, including custom fields.
   * Each field has at least { id, name, custom }.
   *
   * Used to seed a `{fieldId: fieldName}` map at --collect time so the applier
   * can translate DC custom field IDs to Cloud IDs by name.
   */
  async getAllFields() {
    return this.makeRequest("GET", "/rest/api/2/field");
  }

  getStats() {
    return { requestCount: this.requestCount, errorCount: this.errorCount };
  }
}

module.exports = JiraDcClient;
