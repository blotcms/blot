#!/usr/bin/env node
// Fails when the runner's OS is not the version the references were captured on
// (os-versions.json). See UPDATING-OS.md for what to do when it does.
//
//   node check-os.js            everything recorded for this OS (Linux: needs Nautilus and
//                               libadwaita installed, so run it after the apt install)
//   node check-os.js --basic    only the release / build (for jobs that don't install the app)
//
// Plain Node with no dependencies: it runs on all three runners, and on Windows it is
// downloaded next to os-versions.json because the repo can't be checked out there.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const GUIDE = "app/helper/pane/screenshots/UPDATING-OS.md";

const PLATFORMS = { darwin: "macos", win32: "windows", linux: "linux" };
const LABELS = {
  macos: { version: "macOS" },
  windows: { build: "Windows build" },
  linux: { release: "Ubuntu", nautilus: "Nautilus", libadwaita: "libadwaita" },
};
// what --basic checks
const BASIC = { macos: ["version"], windows: ["build"], linux: ["release"] };

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) {
    return "";
  }
};

const majorMinor = (v) => (/^(\d+)\.(\d+)/.exec(v || "") || [])[0];
const major = (v) => (/^(\d+)/.exec(v || "") || [])[1];

// The visually relevant version fields of the machine we are on. `sh` runs a command and
// returns its output (injected by tests).
function observe(platform, options = {}) {
  const sh = options.sh || run;
  const release = options.release || os.release();
  const osRelease = options.osRelease === undefined ? read("/etc/os-release") : options.osRelease;
  const key = PLATFORMS[platform];
  if (key === "macos") return { os: key, version: majorMinor(sh("sw_vers", ["-productVersion"])) };
  if (key === "windows") return { os: key, build: (/^\d+\.\d+\.(\d+)/.exec(release) || [])[1] };
  if (key === "linux") {
    const out = { os: key, release: (/^VERSION_ID="?([\d.]+)"?/m.exec(osRelease) || [])[1] };
    if (!options.basic) {
      out.nautilus = major((/(\d+(?:\.\d+)*)\s*$/.exec(sh("nautilus", ["--version"])) || [])[1]);
      out.libadwaita = majorMinor(sh("dpkg-query", ["-W", "-f=${Version}", "libadwaita-1-0"]).replace(/^\d+:/, ""));
    }
    return out;
  }
  return { os: key };
}

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    return "";
  }
}

// [{ field, label, expected, actual }] for every recorded field that differs
function compare(expected, observed, basic) {
  const fields = basic ? BASIC[observed.os] : Object.keys(LABELS[observed.os]);
  return fields
    .filter((f) => expected[observed.os] && expected[observed.os][f] !== undefined)
    .filter((f) => expected[observed.os][f] !== observed[f])
    .map((f) => ({ field: f, label: LABELS[observed.os][f], expected: expected[observed.os][f], actual: observed[f] || "not found" }));
}

function message(os, diffs) {
  const list = diffs.map((d) => `${d.label} ${d.expected} expected, ${d.actual} on this runner`).join("; ");
  return `The ${os} runner's OS changed: ${list}. The reference screenshots were captured on the expected version, so nothing was captured or committed. Do not just edit os-versions.json: follow ${GUIDE}.`;
}

function main(argv) {
  const basic = argv.includes("--basic");
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, "os-versions.json"), "utf8"));
  const observed = observe(process.platform, { basic });
  console.log(`runner OS: ${JSON.stringify(observed)}`);
  const diffs = compare(expected, observed, basic);
  if (!diffs.length) return 0;
  const text = message(observed.os, diffs);
  console.log(`::error title=Runner OS changed::${text}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### pane: runner OS changed\n\n${text}\n`);
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { observe, compare, message, majorMinor, major };
