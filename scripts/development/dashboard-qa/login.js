const { execSync } = require("child_process");

// The dashboard of a preview slot (scripts/development/preview.sh), or the
// main stack with --slot main
function target(slot) {
  if (slot === "main")
    return { host: "https://local.blot", container: "blot-node-app-1" };
  return { host: `https://${slot}-local.blot`, container: `blot-node-${slot}` };
}

// A one-time login URL for the local test user
function loginURL({ host, container }) {
  const url = execSync(
    `docker exec ${container} node scripts/blog/access.js example@example.com`
  )
    .toString()
    .split("\n")
    .find((line) => line.startsWith("https://"));
  return url.replace(/^https:\/\/[^/]+/, host) + "&redirected=true";
}

module.exports = { target, loginURL };
