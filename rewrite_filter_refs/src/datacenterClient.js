const https = require("https");
const http = require("http");
const { URL } = require("url");

class DatacenterClient {
  constructor(baseUrl, username, password, log) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const parsed = new URL(this.baseUrl);
    this.protocol = parsed.protocol === "https:" ? https : http;
    this.hostname = parsed.hostname;
    this.port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
    this.basePath = parsed.pathname.replace(/\/$/, "");
    this.authHeader =
      "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    this.log = log || console.log;
    this.requestCount = 0;
    this.errorCount = 0;
  }

  makeRequest(method, path, body = null, retryState = null) {
    const state = retryState || {
      rateLimitAttempts: 0,
      serverErrorAttempts: 0,
    };
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

      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const retry = (newState) =>
        this.makeRequest(method, path, body, newState)
          .then(resolve)
          .catch(reject);

      const req = this.protocol.request(options, (res) => {
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
            this.log(
              `  [DC] Rate limited (429), retrying in ${delay / 1000}s (attempt ${state.rateLimitAttempts + 1}/${maxRateLimitRetries})`
            );
            setTimeout(
              () =>
                retry({
                  ...state,
                  rateLimitAttempts: state.rateLimitAttempts + 1,
                }),
              delay
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
              10000
            );
            this.log(
              `  [DC] Server error (${res.statusCode}), retrying in ${delay / 1000}s (attempt ${state.serverErrorAttempts + 1}/${maxServerRetries})`
            );
            setTimeout(
              () =>
                retry({
                  ...state,
                  serverErrorAttempts: state.serverErrorAttempts + 1,
                }),
              delay
            );
            return;
          }

          if (res.statusCode >= 400) {
            this.errorCount++;
            const error = new Error(
              `DC API ${method} ${path} returned ${res.statusCode}: ${data.substring(0, 500)}`
            );
            error.statusCode = res.statusCode;
            error.responseBody = data;
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
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          this.log(
            `  [DC] Connection error: ${err.message}, retrying in ${delay / 1000}s`
          );
          setTimeout(
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
            delay
          );
          return;
        }
        this.errorCount++;
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        if (state.serverErrorAttempts < maxServerRetries) {
          const delay = 2000 * (state.serverErrorAttempts + 1);
          this.log(`  [DC] Request timeout, retrying in ${delay / 1000}s`);
          setTimeout(
            () =>
              retry({
                ...state,
                serverErrorAttempts: state.serverErrorAttempts + 1,
              }),
            delay
          );
          return;
        }
        this.errorCount++;
        reject(new Error(`DC API request timeout: ${method} ${path}`));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async testConnection() {
    try {
      await this.makeRequest("GET", "/rest/api/2/serverInfo");
      return true;
    } catch (error) {
      this.log(`  [DC] Connection test failed: ${error.message}`);
      return false;
    }
  }

  // Send a form-encoded request (application/x-www-form-urlencoded) and
  // return the raw response body. Used for legacy admin JSP endpoints that
  // are NOT exposed in the REST API on this DC version — notably
  // /secure/admin/filters/ChangeSharedFilterOwner.jspa. Accepts manual redirect
  // handling so callers can distinguish success (302 to the listing) from
  // WebSudo intercept (302 to /authenticate.action).
  makeFormRequest(method, fullPath, formObject = null, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const headers = {
        Authorization: this.authHeader,
        Accept: "text/html, */*",
        // `X-Atlassian-Token: no-check` disables Atlassian's CSRF check on
        // REST endpoints. For JSP forms we ALSO supply atl_token in the body
        // (belt-and-braces), but the header is harmless on either.
        "X-Atlassian-Token": "no-check",
        ...extraHeaders,
      };
      let bodyStr = null;
      if (formObject) {
        bodyStr = Object.entries(formObject)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }
      const options = {
        hostname: this.hostname,
        port: this.port,
        path: this.basePath + fullPath,
        method,
        headers,
        timeout: 30000,
      };
      const req = this.protocol.request(options, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          this.requestCount++;
          // We DO NOT auto-follow 3xx so callers can inspect the Location
          // header — that's how we tell success-redirect (back to filter list)
          // from WebSudo intercept (to /authenticate.action).
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
          });
        });
      });
      req.on("error", (err) => {
        this.errorCount++;
        reject(err);
      });
      req.on("timeout", () => {
        req.destroy();
        this.errorCount++;
        reject(new Error(`Form request timeout: ${method} ${fullPath}`));
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  // GET /rest/api/2/filter/{id}
  // Returns the DC filter object, or `null` on 404 (filter deleted / inaccessible).
  async getFilter(id) {
    try {
      return await this.makeRequest(
        "GET",
        `/rest/api/2/filter/${encodeURIComponent(id)}`
      );
    } catch (error) {
      if (error.statusCode === 404) return null;
      throw error;
    }
  }

  // GET /rest/api/2/field — DC returns a flat array of every field
  // (custom + system) in one shot. We filter to custom fields in the caller
  // because system field IDs ("status", "assignee") are identical on Cloud
  // and don't need remapping.
  async getAllFields() {
    return await this.makeRequest("GET", "/rest/api/2/field");
  }

  // GET /rest/api/2/priority — DC returns a flat array of every priority
  // ({ id, name, description, statusColor, iconUrl, ... }). Priorities are
  // a small static list so no paging is needed.
  async getAllPriorities() {
    return await this.makeRequest("GET", "/rest/api/2/priority");
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
    };
  }
}

module.exports = DatacenterClient;
