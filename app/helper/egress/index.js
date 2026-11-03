const config = require("config");

// What is left of the egress boundary for fetching untrusted, user-supplied
// URLs, which began as the airlock container this module is named after
// (#2257): the fail-closed check for the screenshot job, in
// helper/screenshot. Fetching a URL is the sandbox's: sandbox/fetch (the
// `fetch` job) and the fetch-image job, behind the jail's nftables egress
// filter, which matches the real destination IP at connect() time so it also
// covers redirects and DNS rebinding. See app/sandbox/README.md.
//
// Fail closed: in production a caller that hands us a user-controlled URL
// must go through the sandbox. If this unit has none (a deploy without
// BLOT_SANDBOX=1) we throw here rather than letting the caller fall back to
// fetching the URL directly with no SSRF protection. The individual operation
// fails and its caller degrades gracefully - the app still boots and serves.
// Outside production (dev, tests) nothing is required.

// True in production (see config/index.js)
const required = !!(config.egress && config.egress.required);

const browserConfigured = !!(config.sandbox && config.sandbox.browser);

function assertBrowserReady(label) {
  if (required && !browserConfigured) {
    throw new Error(
      `egress: refusing to screenshot a user-controlled URL${
        label ? " (" + label + ")" : ""
      } - this unit has no sandbox (BLOT_SANDBOX). See app/sandbox/README.md.`
    );
  }
}

module.exports = {
  required,
  browserConfigured,
  assertBrowserReady,
};
