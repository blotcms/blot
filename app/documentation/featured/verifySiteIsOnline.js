// host is a user-set custom domain (blog.domain); fetch it in the sandbox so an
// internal address can't be reached. See app/sandbox/README.md.
const sandboxFetch = require("sandbox/fetch");
const Bottleneck = require("bottleneck");

// Create a single global limiter
const limiter = new Bottleneck({
  maxConcurrent: 5, // up to 5 at the same time
  minTime: 200, // at least 200ms between requests (5 per second)
});

const check = async (host) => {
  try {
    console.log("Checking if " + host + " is online...");

    // Whatever the status, the body is what is judged. Anything over 100
    // characters is rejected below, so 1 KiB of it says enough.
    const res = await sandboxFetch.one(
      {
        url: "https://" + host + "/verify/domain-setup",
        kind: "text",
        anyStatus: true,
        truncate: true,
        maxBytes: 1024,
        timeoutMs: 5000, // 5 seconds
      },
      { label: "featured/verifySiteIsOnline" }
    );

    const body = res.text;

    if (!body || body.indexOf(" ") > -1 || body.length > 100)
      throw new Error("Host " + host + " is not online");

    return true;
  } catch (e) {
    return false;
  }
};

// Wrap check in the limiter!
const limitedCheck = limiter.wrap(check);

// export a function which calls check three times in case of failure and if all fail then it returns false
module.exports = async (host) => {
  for (let i = 0; i < 3; i++) {
    const isOnline = await limitedCheck(host);
    if (isOnline) return true;
  }

  return false;
};
