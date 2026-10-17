const fs = require("fs");
const path = require("path");

// Recursively list the spec files the test runner (scripts/tests) picks up
// under `rootDir`, relative to the working directory and sorted: any *.js
// inside a `tests/` directory or any file named `tests.js`, excluding
// node_modules and anything at or below one of `excludePrefixes` (paths
// relative to the working directory). Also used by scripts/tests/ci/plan.js
// to split suites between CI lanes.
module.exports = function listSpecFiles(rootDir, excludePrefixes = []) {
  const prefixes = excludePrefixes
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.relative(process.cwd(), path.resolve(process.cwd(), p)));

  const isExcluded = (rel) =>
    prefixes.some((prefix) => rel === prefix || rel.startsWith(prefix + path.sep));

  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const rel = path.relative(process.cwd(), full);
        const segments = rel.split(path.sep);
        if (
          (segments.includes("tests") || entry.name === "tests.js") &&
          !isExcluded(rel)
        ) {
          out.push(rel);
        }
      }
    }
  })(path.resolve(process.cwd(), rootDir));
  return out.sort();
};
