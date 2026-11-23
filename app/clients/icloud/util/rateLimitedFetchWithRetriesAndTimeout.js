const Bottleneck = require("bottleneck");
const fetch = require("node-fetch");

// Global rate limiter configuration
const limiter = new Bottleneck({
  maxConcurrent: 5, // Maximum concurrent requests
  minTime: 200, // Minimum time (ms) between requests (e.g., 5 requests per second)
});

// Timeout and retry logic using native fetch
const fetchWithRetriesAndTimeout = async (url, options = {}) => {
  // Destructure and set defaults for timeout and retries. With readBody the
  // promise resolves to the body as a Buffer instead of the response, and
  // the timeout and retries cover reading the body: the timer restarts on
  // each chunk, so a stalled body aborts the attempt (rather than hanging the
  // caller after the headers arrived) while a slow but active one completes.
  // retryDelay waits that many milliseconds before the second attempt,
  // doubling before each one after, so a macserver restart (a few seconds)
  // doesn't use up every attempt at once. 0, the default, retries straight
  // away.
  // signal is the caller's (a sync lock's folder.signal, sync/seize.js): once
  // it aborts, the request in flight is cut off and the promise rejects with
  // its reason, with no retry, as it does if it aborted before the request
  // left the rate limiter's queue.
  const {
    timeout = 10000,
    retries = 3,
    readBody = false,
    retryDelay = 0,
    signal: callerSignal,
    ...fetchOptions
  } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (callerSignal) callerSignal.throwIfAborted();

    // Timeout logic
    const controller = new AbortController();
    const signal = controller.signal;
    let timer = setTimeout(() => controller.abort(), timeout);
    const onCallerAbort = () => controller.abort();
    if (callerSignal)
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const response = await fetch(url, { ...fetchOptions, signal });

      if (!response.ok) {
        throw new Error(
          `HTTP error: ${response.status} - ${response.statusText}`
        );
      }

      if (readBody) {
        // aborting the signal also aborts an in-progress body read
        const chunks = [];
        for await (const chunk of response.body) {
          chunks.push(chunk);
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(), timeout);
        }
        clearTimeout(timer);
        return Buffer.concat(chunks);
      }

      clearTimeout(timer); // Clear the timeout if fetch is successful

      return response; // Return the successful response
    } catch (error) {
      clearTimeout(timer); // Clear the timeout in case of error

      if (callerSignal && callerSignal.aborted) throw callerSignal.reason;

      // Handle timeout or other fetch errors
      if (error.name === "AbortError") {
        console.error(
          `Request timed out (attempt ${attempt} of ${retries}): ${url}`
        );
      } else {
        console.error(
          `Request failed: ${url} ${error.message} (attempt ${attempt}/${retries})`
        );

        if (options && options.headers && options.headers.blogID) {
          console.error(`- blog id: ${options.headers.blogID}`);
        }

        if (options && options.headers && options.headers.pathBase64) {
          console.error(
            `- path: ${Buffer.from(options.headers.pathBase64, "base64").toString("utf8")}`
          );
        }

        if (options && options.body) {
          console.error(`- body size: ${options.body.length} bytes`);
        }

        // log if the abort signal was triggered for any reason
        if (signal.aborted) {
          console.error(`- abort signal was triggered`);
        } else {
          console.error(`- abort signal was not triggered`);
        }
      }

      // If all retries fail, throw the error
      if (attempt === retries) {
        throw new Error(
          `Request failed after ${retries} retries: ${error.message} ${url}`,
          { cause: error }
        );
      }

      if (retryDelay > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelay * 2 ** (attempt - 1))
        );
      }
    } finally {
      if (callerSignal)
        callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
};

// Wrap the fetchWithRetriesAndTimeout function with the rate limiter
const rateLimitedFetchWithRetriesAndTimeout = limiter.wrap(
  fetchWithRetriesAndTimeout
);

module.exports = rateLimitedFetchWithRetriesAndTimeout;
