import Bottleneck from "bottleneck";
import fetch from "node-fetch";
import http from "http";
import https from "https";
import clfdate from "../util/clfdate.js";

// At most five requests to Blot at once. There is no minimum gap between
// them: Blot takes each blog's sync lock and builds the entry in well under
// a second, and a 200ms gap made it the slowest step of a burst of files.
const limiter = new Bottleneck({ maxConcurrent: 5 });

// Connections are reused: a new TLS connection to Blot costs about 60ms of
// a 90ms request. Idle ones close after 15s, before the proxy closes them.
const agentOptions = { keepAlive: true, maxSockets: 5, timeout: 15_000 };
const agents = {
  "http:": new http.Agent(agentOptions),
  "https:": new https.Agent(agentOptions),
};
const agent = (url) => agents[url.protocol];

// Timeout and retry logic using native fetch
const fetchWithRetriesAndTimeout = async (url, options = {}) => {
  // Destructure and set defaults for timeout and retries
  const { timeout = 10000, retries = 3, ...fetchOptions } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    // Timeout logic
    const controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { agent, ...fetchOptions, signal });

      clearTimeout(timer); // Clear the timeout if fetch is successful

      if (!response.ok) {
        const httpError = new Error(
          `HTTP error: ${response.status} - ${response.statusText}`
        );
        httpError.status = response.status;
        throw httpError;
      }

      return response; // Return the successful response
    } catch (error) {
      clearTimeout(timer); // Clear the timeout in case of error

      // Handle timeout or other fetch errors
      if (error.name === "AbortError") {
        console.error(
          clfdate(),
          `Request timed out (attempt ${attempt} of ${retries}): ${url}`
        );
      } else {
        console.error(
          clfdate(),
          `Request failed: ${url} ${error.message} (attempt ${attempt}/${retries})`
        );

        if (options && options.headers && options.headers.blogID) {
          console.error(clfdate(), `- blog id: ${options.headers.blogID}`);
        }

        if (options && options.headers && options.headers.pathBase64) {
          console.error(
            clfdate(),
            `- path: ${Buffer.from(options.headers.pathBase64, "base64").toString("utf8")}`
          );
        }

        if (options && options.body) {
          console.error(clfdate(), `- body size: ${options.body.length} bytes`);
        }

        // log if the abort signal was triggered for any reason
        if (signal.aborted) {
          console.error(clfdate(), `- abort signal was triggered`);
        } else {
          console.error(clfdate(), `- abort signal was not triggered`);
        }
      }

      // If all retries fail, throw the error
      if (attempt === retries) {
        const finalError = new Error(
          `Request failed after ${retries} retries: ${error.message} ${url}`
        );
        // lets callers tell an HTTP rejection (e.g. 400) from a network failure
        finalError.status = error.status;
        throw finalError;
      }
    }
  }
};

// Wrap the fetchWithRetriesAndTimeout function with the rate limiter
const rateLimitedFetchWithRetriesAndTimeout = limiter.wrap(
  fetchWithRetriesAndTimeout
);

export default rateLimitedFetchWithRetriesAndTimeout;
