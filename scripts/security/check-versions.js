#!/usr/bin/env node
// config/versions.env is the one place the project's versions and pins live
// (the macserver's Node, which differs on purpose, is not in it). This exits
// non-zero if:
//   - NODE_BASE isn't node:<NODE_VERSION>-alpine@sha256:<digest>;
//   - a Dockerfile gives one of the file's keys a default (they take build args);
//   - a tracked file repeats a value instead of reading it, such as
//     node:<NODE_VERSION>, node-version: <NODE_VERSION> or the minio image;
//   - .github/actions/versions doesn't declare an output for every key.
// Run by CI (unit-image.yml) and by check-advisories.js.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parse } = require("../versions");

const ROOT = path.resolve(__dirname, "..", "..");

// Not scanned for repeated values: dependencies and lockfiles, vendored
// templates and fonts, history (TODO), and the file that holds the values.
const SKIP = [
  "**/node_modules/**",
  "**/package-lock.json",
  "**/*.lock",
  "app/templates/**",
  "**/*.woff*",
  "TODO",
  "**/CHANGELOG*",
  "config/versions.env",
  "scripts/security/check-versions.js",
];

function readVersions() {
  return parse(
    fs.readFileSync(path.join(ROOT, "config", "versions.env"), "utf8")
  );
}

function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (e.status === 1) return ""; // git grep: no match
    throw e;
  }
}

// The text that would repeat a value instead of reading it from the file
function literals(v) {
  const out = [
    "node:" + v.NODE_VERSION,
    "node-version: " + v.NODE_VERSION,
    "redis:" + v.REDIS_VERSION,
    "toxiproxy:" + v.TOXIPROXY_VERSION,
  ];
  // Every other value that is long enough to be a ref, digest or commit
  for (const [key, value] of Object.entries(v)) {
    if (key !== "NODE_VERSION" && /^(.*[:@].*|[0-9a-f]{40,})$/.test(value))
      out.push(value);
  }
  return out;
}

function problems() {
  const out = [];
  const v = readVersions();

  if (!v.NODE_VERSION || !v.NODE_BASE)
    return ["config/versions.env needs NODE_VERSION and NODE_BASE"];
  const base = "node:" + v.NODE_VERSION + "-alpine@sha256:";
  if (
    !v.NODE_BASE.startsWith(base) ||
    !/^[0-9a-f]{64}$/.test(v.NODE_BASE.slice(base.length))
  )
    out.push(
      "NODE_BASE must be " + base + "<64 hex digits>, got " + v.NODE_BASE
    );

  // Dockerfiles take every key as a build arg, with no default
  const files = git(
    "ls-files",
    "--",
    "Dockerfile",
    "**/Dockerfile",
    "**/Dockerfile.*"
  )
    .split("\n")
    .filter(Boolean);
  for (const file of files) {
    for (const line of fs
      .readFileSync(path.join(ROOT, file), "utf8")
      .split("\n")) {
      const m = line.match(/^\s*ARG\s+([A-Z][A-Z0-9_]*)=/);
      if (m && m[1] in v)
        out.push(
          file +
            ": ARG " +
            m[1] +
            " has a default; it comes from config/versions.env"
        );
    }
  }

  // No other tracked file repeats a value
  const exclude = SKIP.map((p) => ":(exclude,glob)" + p);
  for (const text of literals(v)) {
    const hits = git("grep", "-nF", "-e", text, "--", ".", ...exclude)
      .split("\n")
      .filter(Boolean);
    for (const hit of hits)
      out.push(
        "repeats " +
          text +
          ", read config/versions.env instead: " +
          hit.slice(0, 120)
      );
  }

  // The composite action declares an output per key (steps.versions.outputs.KEY)
  const action = fs.readFileSync(
    path.join(ROOT, ".github/actions/versions/action.yml"),
    "utf8"
  );
  for (const key of Object.keys(v)) {
    if (!new RegExp("^  " + key + ":$", "m").test(action))
      out.push(".github/actions/versions/action.yml: no output for " + key);
  }

  return out;
}

module.exports = { readVersions, problems };

if (require.main === module) {
  const found = problems();
  if (found.length) {
    console.error(found.join("\n"));
    process.exit(1);
  }
  console.log(
    "config/versions.env is the only place its " +
      Object.keys(readVersions()).length +
      " versions are set"
  );
}
