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
  return null;
}

async function main() {
  const results = {};
  let sanityFailures = 0;

  for (const c of corpus) {
    const result = await request({ scheme: c.scheme, host: c.host, base: BASE, path: c.path, method: c.method, headers: c.headers });
    results[c.name] = result;

    const problem = checkSanity(c.name, c.sanity, result);
    if (problem) {
      sanityFailures++;
      console.error(`  SANITY FAIL [${label}] ${c.name}: ${problem}`);
    }
  }

  // Blot-Cache MISS -> HIT: two sequential requests to the same key.
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

  fs.writeFileSync(outFile, JSON.stringify({ label, results }, null, 2));
  console.log(`[${label}] captured ${corpus.length + 1} cases -> ${outFile}`);

  if (sanityFailures > 0) {
    console.error(`[${label}] ${sanityFailures} sanity check(s) failed - the corpus itself looks wrong, independent of the other config`);
    process.exit(1);
  }
}

main();
