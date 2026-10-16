// Writes app/documentation/latest-commits.json: the unix-ms timestamp of the
// latest commit touching each template source directory. Run in CI, where
// .git exists, before the production image is built (the image has no .git).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.join(__dirname, "../../../");
const sourceDirectory = path.join(repoRoot, "app/templates/source");
const output = path.join(__dirname, "../latest-commits.json");

const latest = {};

for (const slug of fs.readdirSync(sourceDirectory)) {
  if (!fs.existsSync(path.join(sourceDirectory, slug, "package.json"))) continue;

  const seconds = execFileSync(
    "git",
    ["log", "-1", "--format=%ct", "--", path.join(sourceDirectory, slug)],
    { cwd: repoRoot, encoding: "utf8" }
  ).trim();

  latest[slug] = seconds ? parseInt(seconds, 10) * 1000 : 0;
}

fs.writeFileSync(output, JSON.stringify(latest, null, 2) + "\n");
console.log(`Wrote ${Object.keys(latest).length} template timestamps to ${output}`);
