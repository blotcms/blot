#!/usr/bin/env node
// Runs the request corpus (corpus.js) against one running config (bare-metal
// or container, both listening on the runner's own :80/:443 - see run.sh)
// and writes the results as JSON, for diff.js to compare against the other
// config's capture.
//
// Usage: DIFFERENTIAL_HOST=<ip> node capture.js <label> <out-file>
//   label     "container" or "baremetal" - included in the output for
//             readability; also used in sanity-check failure messages.
const fs = require("fs");
const { request } = require("./lib");
const { corpus, cacheSequence } = require("./corpus");

const label = process.argv[2];
const outFile = process.argv[3];
if (!label || !outFile) {
  console.error("usage: node capture.js <label> <out-file>");
  process.exit(1);
}

// Both configs run with --network host, bound directly to the runner's own
// ports (see run.sh; only one of the two is up at a time). NOT 127.0.0.1:
// server.conf's internal purge/inspect server also binds 127.0.0.1:80 -
// loopback only - and on --network host that's the SAME loopback this
// client uses, so it shadows the blog/custom-domain default_server for
// anything sent there (every corpus case came back 404 from the wrong
// server - see run.sh). run.sh passes the runner's own routable IP here.
const BASE = process.env.DIFFERENTIAL_HOST || "127.0.0.1";

function checkSanity(name, sanity, result) {
  if (!sanity) return null;
  if (sanity.status !== undefined && result.status !== sanity.status) {
    return `expected status ${sanity.status}, got ${result.status}`;
  }
  if (sanity.statusNot !== undefined && result.status === sanity.statusNot) {
    return `expected status != ${sanity.statusNot}, got ${result.status}`;
  }
  if (sanity.locationStartsWith !== undefined) {
    const loc = result.headers.location || "";
    if (!loc.startsWith(sanity.locationStartsWith)) {
      return `expected Location to start with '${sanity.locationStartsWith}', got '${loc}'`;
    }
  }
  if (sanity.servedFromDisk) {
    // The `location /` this is served from (server.conf's cdn. host) proxies
    // to Node - and sets Blot-Server/Blot-Cache/Blot-Upstream - only in its
    // @cdn_node fallback; a real on-disk hit never reaches proxy_pass, so
    // Blot-Upstream must be absent. Cache-Control is the header that specific
    // fallback is missing (blotcms/blot#1941), so its presence here is what
    // actually distinguishes "served from disk" from "fell through to node
    // but still returned 200" - status alone doesn't.
    if (result.headers["blot-upstream"] !== undefined) {
      return `expected no Blot-Upstream header (should be served from disk, not proxied to node), got '${result.headers["blot-upstream"]}'`;
    }
    // Substring, not equality: the location sets both `expires 1y` and an
    // explicit `add_header Cache-Control "public, max-age=31536000"`, and
    // nginx emits BOTH (add_header does not replace what expires already
    // added) - e.g. "max-age=31536000, public, max-age=31536000". Pre-existing
    // and identical on both configs (same conf file); not this PR's bug to
    // fix, just to not choke on.
    const cacheControl = result.headers["cache-control"] || "";
    if (!cacheControl.includes("public, max-age=31536000")) {
      return `expected Cache-Control to include 'public, max-age=31536000' (the cdn. location's on-disk add_header), got '${cacheControl}'`;
    }
  }
  return null;
}

async function main() {
  const results = {};
  let sanityFailures = 0;

  // Blot-Cache MISS -> HIT: two sequential requests to the same key. Run
  // BEFORE the corpus loop below, not after: the loop's "/boom" case (stub
  // 500) trips blot_blogs_node's `max_fails` on its primary upstream, and
  // since nginx counts fails per worker (no shared zone), whichever worker
  // picks up the NEXT request to that upstream nondeterministically decides
  // whether it still sees the primary disabled and falls to `backup` - see
  // the comment next to /boom in corpus.js. Running the cache sequence first
  // keeps it, and everything before /boom, deterministic.
  const first = await request({ scheme: cacheSequence.scheme, host: cacheSequence.host, base: BASE, path: cacheSequence.path });
  const second = await request({ scheme: cacheSequence.scheme, host: cacheSequence.host, base: BASE, path: cacheSequence.path });
  results[cacheSequence.name] = { first, second };

  if (first.headers["blot-cache"] !== "MISS") {
    sanityFailures++;
    console.error(`  SANITY FAIL [${label}] ${cacheSequence.name}: first request Blot-Cache was '${first.headers["blot-cache"]}', want MISS`);
  }
  if (second.headers["blot-cache"] !== "HIT") {
    sanityFailures++;
    console.error(`  SANITY FAIL [${label}] ${cacheSequence.name}: second request Blot-Cache was '${second.headers["blot-cache"]}', want HIT`);
  }

  for (const c of corpus) {
    const result = await request({ scheme: c.scheme, host: c.host, base: BASE, path: c.path, method: c.method, headers: c.headers });
    results[c.name] = result;

    const problem = checkSanity(c.name, c.sanity, result);
    if (problem) {
      sanityFailures++;
      console.error(`  SANITY FAIL [${label}] ${c.name}: ${problem}`);
    }
  }

  fs.writeFileSync(outFile, JSON.stringify({ label, results }, null, 2));
  console.log(`[${label}] captured ${corpus.length + 1} cases -> ${outFile}`);

  if (sanityFailures > 0) {
    console.error(`[${label}] ${sanityFailures} sanity check(s) failed - the corpus itself looks wrong, independent of the other config`);
    process.exit(1);
  }
}

main();
