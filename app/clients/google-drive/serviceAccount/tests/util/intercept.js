const nock = require("nock");
const fs = require("fs-extra");
const path = require("path");
const fetch = require("node-fetch"); // Import node-fetch for forwarding requests

// Base directory for fixtures
const FIXTURE_DIR = path.resolve(__dirname, "fixtures");

/**
 * Intercept and capture all Google API GET and POST responses, or replay saved fixtures.
 * @param {string} specName - Name of the spec (e.g., "refresh-service-account").
 * @param {string} identifier - Unique identifier for the request (e.g., "about-get").
 */
function intercept(specName, identifier) {
  // Ensure the fixture directory exists
  if (!fs.existsSync(FIXTURE_DIR)) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  }

  // Hardcoded Google APIs base URL
  const GOOGLE_API_BASE = "https://www.googleapis.com";

  // Intercept all POST requests (e.g., /oauth2/v4/token)
  nock(GOOGLE_API_BASE)
    .persist()
    .intercept(/.*/, "POST")
    .times(100000)
    .reply(async function (uri, requestBody, callback) {
      const fixturePath = path.join(
        FIXTURE_DIR,
        `${specName}-${identifier}-POST-${uri.replace(/\//g, "_")}.json`
      );

      if (fs.existsSync(fixturePath)) {
        console.log(`Replaying fixture for POST request to ${uri}`);
        const fixture = fs.readJsonSync(fixturePath);

        // Replay headers and response body
        callback(null, [fixture.status, fixture.response, fixture.headers]);
        return;
      }

      console.log(`Forwarding POST request to ${uri}`);
      const remoteResponse = await forwardRequest(
        GOOGLE_API_BASE + uri,
        "POST",
        requestBody,
        this.req.headers
      );

      // Save the response as a fixture
      saveFixture(
        uri,
        "POST",
        remoteResponse.status,
        remoteResponse.body,
        fixturePath,
        requestBody,
        remoteResponse.headers
      );

      // Return the response to the caller
      callback(null, [
        remoteResponse.status,
        remoteResponse.body,
        remoteResponse.headers,
      ]);
    });

  // Intercept all GET requests (e.g., /drive/v3/about)
  nock(GOOGLE_API_BASE)
    .persist()
    .intercept(/.*/, "GET")
    .times(100000)
    .reply(async function (uri, requestBody, callback) {
      const fixturePath = path.join(
        FIXTURE_DIR,
        `${specName}-${identifier}-GET-${uri.replace(/\//g, "_")}.json`
      );

      if (fs.existsSync(fixturePath)) {
        console.log(`Replaying fixture for GET request to ${uri}`);
        const fixture = fs.readJsonSync(fixturePath);

        // Replay headers and response body
        callback(null, [fixture.status, fixture.response, fixture.headers]);
        return;
      }

      console.log(`Forwarding GET request to ${uri}`);
      const remoteResponse = await forwardRequest(
        GOOGLE_API_BASE + uri,
        "GET",
        null,
        this.req.headers
      );

      // Save the response as a fixture
      saveFixture(
        uri,
        "GET",
        remoteResponse.status,
        remoteResponse.body,
        fixturePath,
        null,
        remoteResponse.headers
      );

      // Return the response to the caller
      callback(null, [
        remoteResponse.status,
        remoteResponse.body,
        remoteResponse.headers,
      ]);
    });
}

/**
 * Forward a request to the actual remote server and return its response.
 * @param {string} url - The full URL of the remote server.
 * @param {string} method - The HTTP method (e.g., "POST").
 * @param {object} [body] - The request body, if applicable (for POST).
 * @param {object} [headers] - The request headers.
 * @returns {Promise<{status: number, body: object, headers: object}>} - The response status, body, and headers.
 */
async function forwardRequest(url, method, body = null, headers = {}) {
  const options = {
    method,
    headers: {
      ...headers, // Pass through all headers
    },
  };

  if (body) {
    options.body = body;
  }

  // Temporarily disable nock to forward the request
  nock.restore(); // Disable nock
  const response = await fetch(url, options);
  nock.activate(); // Re-enable nock

  if (!response.ok) {
    throw new Error(`Error forwarding request: ${response.statusText}`);
  }

  const responseBody = await response.json();
  const responseHeaders = Object.fromEntries(response.headers.entries()); // Convert headers to an object
  return {
    status: response.status,
    body: responseBody,
    headers: responseHeaders,
  };
}

/**
 * Save the intercepted response as a fixture.
 * @param {string} uri - The request URI.
 * @param {string} method - The HTTP method (e.g., "GET" or "POST").
 * @param {number} status - The HTTP status code.
 * @param {object} response - The response body.
 * @param {string} fixturePath - The path to the fixture file.
 * @param {object} [requestBody] - The body of the POST request, if applicable.
 * @param {object} [headers] - The response headers.
 */
function saveFixture(
  uri,
  method,
  status,
  response,
  fixturePath,
  requestBody = null,
  headers = {}
) {
  const fixture = {
    path: uri,
    method,
    status,
    response,
    headers,
    requestBody: requestBody || undefined, // Save the request body for POST if provided
  };

  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), "utf8");
}

module.exports = intercept;
