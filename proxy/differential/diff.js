#!/usr/bin/env node
// Compares two capture.js output files (one from the container config, one
// from the bare-metal config run through the same corpus - see run.sh) and
// fails if they disagree on anything not explicitly allowed to differ.
//
// Usage: node diff.js <container-capture.json> <baremetal-capture.json>
const fs = require("fs");
const { CAPTURED_HEADERS, IGNORE_VALUE_OF } = require("./lib");

const [, , containerFile, baremetalFile] = process.argv;
if (!containerFile || !baremetalFile) {
  console.error("usage: node diff.js <container-capture.json> <baremetal-capture.json>");
  process.exit(1);
}

const container = JSON.parse(fs.readFileSync(containerFile, "utf8"));
const baremetal = JSON.parse(fs.readFileSync(baremetalFile, "utf8"));

// ---------------------------------------------------------------------------
// Allowlist: differences that are EXPECTED between the two configs, and why.
// Nothing in the request corpus should ever land here - it exists so a case
// added later that legitimately depends on one of these can be exempted
// explicitly and visibly, rather than by loosening the comparison generally.
//
//   - the health socket (proxy/build/sync-config.js's server.conf adaptation)
//     is unix-only and container-local; the corpus never targets it.
//   - `reuseport` on the container's listeners changes nothing a client can
//     observe.
//   - stdout vs file logging (LOG_TO_STDOUT) is not in any response.
//   - the container's Bunny edge-IP allowlist is normally fetched at
//     runtime/build time from BunnyCDN; both sides run with it disabled here
//     (FETCH_CDN_IPS=false / PROXY_FETCH_CDN_IPS=false in run.sh) so this
//     never actually diverges in this harness, but would not be a bug if it
//     did (a rate-limit allowlist, not externally observable per-request).
// ---------------------------------------------------------------------------
const ALLOWED_DIFFERENCES = new Set([
  // "<case name>|<header>" entries go here if a real, expected difference is
  // ever found. Empty: every case below is expected to match exactly.
  //
  // A "Blot-Cache MISS then HIT (first)|blot-upstream" difference showed up
  // here briefly (blotcms/blot#1977, commit 962c07b, job 107622786236): the
  // corpus's own /boom case (stub 500) trips blot_blogs_node's `max_fails` on
  // its primary upstream, and since nginx counts fails per worker with no
  // shared zone, whichever worker picks up the next request to that upstream
  // nondeterministically decides whether it still sees the primary disabled.
  // Fixed at the source instead of allowlisted here: capture.js now runs the
  // cache sequence before the corpus loop, and /boom and /unavailable are
  // the last entries in corpus.js - see the comment there.
]);

let failures = 0;
let checked = 0;

function fail(name, detail) {
  failures++;
  console.log(`  DIFF - ${name}: ${detail}`);
}

function compareOne(name, a, b) {
  checked++;
  if (a.status !== b.status) {
    fail(name, `status: container=${a.status} baremetal=${b.status}`);
    return;
  }
  for (const header of CAPTURED_HEADERS) {
    const av = a.headers[header];
    const bv = b.headers[header];
    const present = av !== undefined || bv !== undefined;
    if (!present) continue;

    const key = `${name}|${header}`;
    if (ALLOWED_DIFFERENCES.has(key)) continue;

    if ((av === undefined) !== (bv === undefined)) {
      fail(name, `header '${header}' present=${av !== undefined} vs present=${bv !== undefined} (container='${av}' baremetal='${bv}')`);
    } else if (!IGNORE_VALUE_OF.has(header) && av !== bv) {
      fail(name, `header '${header}': container='${av}' baremetal='${bv}'`);
    }
  }
}

for (const name of Object.keys(container.results)) {
  const a = container.results[name];
  const b = baremetal.results[name];
  if (!b) {
    fail(name, "present in container capture, missing from baremetal capture");
    continue;
  }

  if (a.first && a.second) {
    // Blot-Cache MISS -> HIT sequence
    compareOne(`${name} (first)`, a.first, b.first);
    compareOne(`${name} (second)`, a.second, b.second);
  } else {
    compareOne(name, a, b);
  }
}

for (const name of Object.keys(baremetal.results)) {
  if (!container.results[name]) fail(name, "present in baremetal capture, missing from container capture");
}

console.log(`\nChecked ${checked} case(s), ${failures} unexplained difference(s).`);
process.exit(failures > 0 ? 1 : 0);
