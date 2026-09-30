#!/usr/bin/env node
// Prints the hosted-runner labels that are newer than the ones pinned in os-versions.json,
// one line each ("macos-27"), and nothing when we are on the newest. Run weekly by
// .github/workflows/pane-os-watch.yml, which opens an issue pointing at UPDATING-OS.md.
//
// Source: the table in actions/runner-images/README.md (labels like `macos-26`,
// `windows-2025`, `ubuntu-26.04`). Only x64 or arm64 base images count: the -arm, -large,
// -xlarge, -intel and -vs20xx variants and the moving `-latest` labels are ignored.

const fs = require("fs");
const path = require("path");

const README = "https://raw.githubusercontent.com/actions/runner-images/main/README.md";

// family -> how to read the version out of a label
const FAMILIES = {
  macos: /^macos-(\d+)$/,
  windows: /^windows-(\d{4})$/,
  linux: /^ubuntu-(\d+)\.(\d+)$/,
};

const versionOf = (family, label) => {
  const m = FAMILIES[family].exec(label);
  return m && m.slice(1).map(Number);
};

const newer = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
};

// labels newer than each family's pinned one, from the README text
function newerLabels(readme, pinned) {
  const labels = [...new Set([...readme.matchAll(/`([a-z]+-[\d.]+[a-z0-9.-]*)`/g)].map((m) => m[1]))];
  const found = [];
  for (const family of Object.keys(FAMILIES)) {
    const current = versionOf(family, pinned[family].runner);
    if (!current) throw new Error(`pinned ${family} runner "${pinned[family].runner}" is not a versioned label`);
    const candidates = labels.filter((l) => versionOf(family, l) && newer(versionOf(family, l), current));
    candidates.sort((a, b) => (newer(versionOf(family, a), versionOf(family, b)) ? -1 : 1));
    if (candidates.length) found.push({ family, pinned: pinned[family].runner, newest: candidates[0] });
  }
  return found;
}

async function main() {
  const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, "os-versions.json"), "utf8"));
  const res = await fetch(README);
  if (!res.ok) throw new Error(`could not fetch ${README}: ${res.status}`);
  for (const f of newerLabels(await res.text(), pinned)) console.log(`${f.family} ${f.pinned} ${f.newest}`);
}

if (require.main === module) main().catch((e) => (console.error(e), process.exit(2)));

module.exports = { newerLabels, versionOf, newer };
