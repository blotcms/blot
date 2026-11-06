// host is a user-set custom domain (blog.domain); fetch it in the sandbox so an
// internal address can't be reached. See app/sandbox/README.md.
const sandboxFetch = require("sandbox/fetch");

module.exports = async function fetchSubscriptionDuration(host) {
  try {
    // A status other than 2xx is an error of the fetch: no duration
    const response = await sandboxFetch.one(
      {
        url: "https://" + host + "/verify/subscription-duration",
        kind: "text",
        maxBytes: 4096,
        timeoutMs: 5000,
      },
      { label: "featured/fetchSubscriptionDuration" }
    );

    if (response.status === 204) return null;

    let payload = null;
    try {
      payload = JSON.parse(response.text);
    } catch (e) {
      payload = null;
    }
    const duration = payload && payload.duration;

    if (!Number.isFinite(duration) || duration <= 0) return null;

    return duration;
  } catch (error) {
    return null;
  }
};
