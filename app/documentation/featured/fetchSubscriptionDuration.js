// host is a user-set custom domain (blog.domain); fetch it through the
// airlock proxy so an internal address can't be reached. See helper/airlock.
const fetch = require("helper/airlock").fetch;

module.exports = async function fetchSubscriptionDuration(host) {
  try {
    const response = await fetch(
      "https://" + host + "/verify/subscription-duration",
      { timeout: 5000 }
    );

    if (response.status === 404 || response.status === 204) return null;
    if (!response.ok) return null;

    const payload = await response.json().catch(() => null);
    const duration = payload && payload.duration;

    if (!Number.isFinite(duration) || duration <= 0) return null;

    return duration;
  } catch (error) {
    return null;
  }
};
