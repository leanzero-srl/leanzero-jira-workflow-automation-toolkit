/**
 * Jira API client for making authenticated HTTP requests
 */

const axios = require("axios");
const { logger } = require("../utils/logger");

/**
 * Create basic auth header value
 * @param {string} username - User email (can be empty if apiToken is pre-encoded)
 * @param {string} apiToken - API token or pre-encoded base64 auth string
 * @returns {string} Base64 encoded auth string
 */
function createAuthHeader(username, apiToken) {
  // If apiToken is already base64 encoded (the full auth string),
  // use it directly. Check if it's already encoded by attempting to decode it
  // and seeing if it contains a colon (username:token format)
  try {
    const decoded = Buffer.from(apiToken, "base64").toString("utf-8");
    if (decoded.includes(":") && decoded.length > apiToken.length * 0.7) {
      // Looks like it's already base64-encoded username:token
      return apiToken;
    }
  } catch (e) {
    // Not valid base64, treat as raw token
  }

  // Raw token, encode it with username
  return Buffer.from(`${username}:${apiToken}`).toString("base64");
}

/**
 * Make a GET request to Jira API
 * @param {string} url - Full URL to request
 * @param {string} username - User email
 * @param {string} apiToken - API token
 * @param {Object} params - Query parameters (optional)
 * @param {number} timeout - Request timeout in ms (default: 30000)
 * @returns {Promise<Object>} Response data
 */
async function get(url, username, apiToken, params = {}, timeout = 30000) {
  const auth = createAuthHeader(username, apiToken);
  const headers = {
    Accept: "application/json",
    Authorization: `Basic ${auth}`,
  };

  try {
    const response = await axios.get(url, {
      headers,
      params,
      timeout,
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(
        `HTTP ${error.response.status}: ${error.response.statusText} - ${JSON.stringify(error.response.data)}`,
      );
    } else {
      throw error;
    }
  }
}

/**
 * Make a PUT request to Jira API
 * @param {string} url - Full URL to request
 * @param {string} username - User email
 * @param {string} apiToken - API token
 * @param {Object} data - Request body
 * @param {number} timeout - Request timeout in ms (default: 30000)
 * @returns {Promise<Object>} Response data
 */
async function put(url, username, apiToken, data, timeout = 30000) {
  const auth = createAuthHeader(username, apiToken);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Basic ${auth}`,
  };

  try {
    const response = await axios.put(url, data, {
      headers,
      timeout,
    });
    return {
      status: response.status,
      data: response.data,
    };
  } catch (error) {
    if (error.response) {
      return {
        status: error.response.status,
        data: error.response.data,
        error: true,
      };
    } else {
      throw error;
    }
  }
}

/**
 * Make a POST request to Jira API
 * @param {string} url - Full URL to request
 * @param {string} username - User email
 * @param {string} apiToken - API token
 * @param {Object} data - Request body
 * @param {number} timeout - Request timeout in ms (default: 30000)
 * @returns {Promise<Object>} Response data
 */
async function post(url, username, apiToken, data, timeout = 30000) {
  const auth = createAuthHeader(username, apiToken);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Basic ${auth}`,
  };

  try {
    const response = await axios.post(url, data, {
      headers,
      timeout,
    });
    return {
      status: response.status,
      data: response.data,
    };
  } catch (error) {
    if (error.response) {
      throw new Error(
        `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`,
      );
    } else {
      throw error;
    }
  }
}

/**
 * Get paginated data from Jira REST API (standard Jira API, not Automation API)
 * @param {string} email - User email
 * @param {string} apiToken - API token
 * @param {string} siteUrl - Full site URL (e.g., yourcompany.atlassian.net)
 * @param {string} endpoint - API endpoint (starting with /)
 * @param {Object} extraParams - Additional query parameters to merge (optional)
 * @returns {Promise<Array>} All data from paginated endpoint
 */
async function getPaginatedData(email, apiToken, siteUrl, endpoint, extraParams = {}) {
  // FIXED: Construct correct URL for standard Jira REST API
  const url = `https://${siteUrl}/rest/api/3${endpoint}`;
  const allData = [];
  let startAt = 0;
  const maxResults = 50;

  while (true) {
    const params = {
      ...extraParams,
      startAt,
      maxResults,
    };

    try {
      const data = await get(url, email, apiToken, params);

      let values = [];

      // Check if response is directly an array (like /issuetype, /field, /status, /users/search)
      if (Array.isArray(data)) {
        values = data;
      } else if (data && data.values && Array.isArray(data.values)) {
        // Response has a values property (like /project/search)
        values = data.values;
      } else {
        logger.warn(
          `Unexpected data format from ${endpoint}. Type: ${typeof data}, Has values: ${!!data?.values}`,
        );
        values = [];
      }

      // Check for duplicate data (some endpoints like /issuetype ignore pagination params)
      if (values.length > 0 && allData.length > 0) {
        // If first item of new batch has same ID as any existing item, we're getting duplicates
        const firstNewId = values[0].id;
        if (firstNewId && allData.some((item) => item.id === firstNewId)) {
          // Duplicate data detected - endpoint doesn't support pagination
          break;
        }
      }

      allData.push(...values);

      // Check if we have more data (for paginated endpoints)
      if (values.length < maxResults) {
        break;
      }

      startAt += maxResults;
    } catch (error) {
      logger.error(`Error fetching data from ${endpoint}: ${error.message}`);
      break;
    }
  }

  return allData;
}

module.exports = {
  get,
  put,
  post,
  getPaginatedData,
  createAuthHeader,
};
