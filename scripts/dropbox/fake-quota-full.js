// Toggle fake "Dropbox account is full" responses in development.
//
//   docker exec -it blot-node-app-1 node scripts/dropbox/fake-quota-full.js on
//   docker exec -it blot-node-app-1 node scripts/dropbox/fake-quota-full.js off
//   docker exec -it blot-node-app-1 node scripts/dropbox/fake-quota-full.js status
//
// While on, Dropbox uploads (e.g. Blot writing a file back to the user's
// folder) fail with Dropbox's path/insufficient_space error. The app
// intercepts the request via scripts/development/fake-dropbox-quota.js,
// which is preloaded by the dev docker-compose.yml.

const fs = require("fs");
const os = require("os");
const path = require("path");

const flagPath = path.join(os.tmpdir(), "blot-dropbox-fake-quota-full");
const command = process.argv[2];

if (command === "on") {
  fs.writeFileSync(flagPath, new Date().toISOString());
  console.log("Fake Dropbox quota-full responses: ON");
} else if (command === "off") {
  fs.rmSync(flagPath, { force: true });
  console.log("Fake Dropbox quota-full responses: OFF");
} else if (command === "status") {
  console.log(
    "Fake Dropbox quota-full responses:",
    fs.existsSync(flagPath) ? "ON" : "OFF"
  );
} else {
  console.error("Usage: node scripts/dropbox/fake-quota-full.js on|off|status");
  process.exit(1);
}
