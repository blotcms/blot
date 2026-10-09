const clients = require("clients");
const health = require("clients/health");
const readOnly = require("helper/readOnly");

// A slow or failing health check must never break or stall a dashboard page.
const TIMEOUT = 2000;

// Attaches `blog.health` and, when the client is in an error state,
// `blog.healthIssue` ({ code, label, message, since }) for templates.
// Clients without getHealth, and any failure, are treated as healthy.
module.exports = async function getBlogHealth(blog) {
  let result = health.ok();
  const client = blog.client && clients[blog.client];

  if (client && typeof client.getHealth === "function") {
    let timer;

    try {
      result = await Promise.race([
        client.getHealth(blog.id),
        new Promise(function (resolve, reject) {
          timer = setTimeout(function () {
            reject(new Error("getHealth timed out"));
          }, TIMEOUT);
        }),
      ]);
    } catch (e) {
      console.error("getHealth failed for", blog.id, e);
      result = health.ok();
    } finally {
      clearTimeout(timer);
    }
  }

  // While Blot is read-only, syncs wait (sync/index.js), so say so rather
  // than let the site look stuck. readOnly.status() counts as off when Redis
  // is unreachable, and a failure here must not break the page either.
  if (blog.client && (!result || result.state !== health.STATES.ERROR)) {
    const frozen = await readOnly.status().catch(() => null);
    if (frozen) {
      result = health.error([
        { code: health.CODES.SYNC_PAUSED, since: frozen.since || undefined },
      ]);
    }
  }

  blog.health = result;
  blog.healthIssue = undefined;

  const issue =
    result && result.state === health.STATES.ERROR
      ? health.primaryIssue(result)
      : undefined;

  if (issue) {
    blog.healthIssue = {
      code: issue.code,
      label: health.label(issue.code),
      message: issue.message,
      since: issue.since,
      action: health.action(issue.code),
    };
  }

  return blog;
};
