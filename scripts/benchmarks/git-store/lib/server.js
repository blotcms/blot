// The harness's server: one repository's operations behind HTTP, run in its
// own process so peak memory is that of the server alone and so the counts of
// requests and bytes to the object store are the server's.
//
//   /<name>.git/info/refs?service=...   ref advertisement
//   /<name>.git/git-upload-pack         clone and fetch
//   /<name>.git/git-receive-pack        push
//   POST /__op/<name>                   materialize, commit, ... (JSON in/out)
//   GET  /__take                        what was counted since the last call
//   POST /__cache/clear                 empties the cache (a cold start)
//   POST /__config                      { limit } shows the repo as of a push
//
// Configuration comes from the environment (see run.js, which starts it).
const http = require("http");
const { createCache } = require("../../../../app/clients/git/store");
const frontMemory = require("./memcache");
const { connect } = require("./stores");
const createManifests = require("./manifests");
const openRepo = require("./repoctx");
const { advertisement, uploadPack, readBody } = require("./fetch");

const config = {
  blogID: process.env.SPIKE_BLOG,
  via: process.env.SPIKE_VIA || "proxied",
  cacheDir: process.env.SPIKE_CACHE_DIR,
  cacheBytes: Number(process.env.SPIKE_CACHE_BYTES || 1024 ** 3),
  port: Number(process.env.SPIKE_PORT || 0),
  retries: Number(process.env.SPIKE_ATTEMPTS || 3),
  requestTimeout: Number(process.env.SPIKE_REQUEST_TIMEOUT || 0),
  keepAlive: process.env.SPIKE_KEEPALIVE !== "0",
};

// A mutex: the harness's stand-in for the per-blog Redis ref lock
function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

async function main() {
  const disk = createCache({ dir: config.cacheDir, maxBytes: config.cacheBytes });
  await disk.ready();
  const cache = frontMemory(disk);
  const connection = connect({ blogID: config.blogID, via: config.via, options: { maxAttempts: config.retries, requestTimeout: config.requestTimeout, keepAlive: config.keepAlive } });
  const { store, counters } = connection;
  const lock = createLock();
  const manifests = createManifests({ store, cache, lock });
  const state = { limit: Infinity, facts: [], peak: 0, base: process.memoryUsage().rss };

  setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > state.peak) state.peak = rss;
  }, 25).unref();

  const faults = {};
  const ops = require("./ops").create({ store, cache, manifests, config, openRepo, faults });

  async function repoNow() {
    const current = await manifests.read();
    return { repo: openRepo({ store, cache, manifest: current, limitSeq: state.limit }), current };
  }

  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname === "/__take") {
        const taken = counters.take();
        const out = {
          counts: taken,
          facts: state.facts,
          rssPeakMB: Math.round(state.peak / 1048576),
          rssBaseMB: Math.round(state.base / 1048576),
          cache: disk.stats(),
          hintFailures: manifests.stats.hintFailures,
        };
        state.facts = [];
        state.peak = process.memoryUsage().rss;
        state.base = state.peak;
        res.end(JSON.stringify(out));
        return;
      }
      if (url.pathname === "/__cache/clear") {
        await cache.clear();
        res.end("{}");
        return;
      }
      if (url.pathname === "/__config") {
        const body = JSON.parse((await readBody(req)).toString() || "{}");
        if (body.limit !== undefined) state.limit = body.limit === null ? Infinity : body.limit;
        // failure injection: { faults: { upload: toxic } } adds that toxiproxy toxic just
        // before a push's pack upload; { swap: toxic } just before its manifest write
        if (body.faults !== undefined) Object.assign(faults, body.faults);
        res.end("{}");
        return;
      }
      if (url.pathname.startsWith("/__op/")) {
        const name = url.pathname.slice(6);
        if (!ops[name]) {
          res.writeHead(404).end("no such op");
          return;
        }
        const input = JSON.parse((await readBody(req)).toString() || "{}");
        const result = await ops[name](input);
        res.end(JSON.stringify(result));
        return;
      }

      if (url.pathname.endsWith("/info/refs")) {
        const service = url.searchParams.get("service");
        const { current } = await repoNow();
        const shown = { ...current, refs: current.refs };
        if (state.limit !== Infinity) {
          const snapshot = [...current.snapshots].reverse().find((s) => s.seq <= state.limit);
          shown.refs = snapshot ? snapshot.refs : {};
        }
        res.writeHead(200, { "content-type": "application/x-" + service + "-advertisement", "cache-control": "no-cache" });
        res.end(advertisement(service, shown));
        state.facts.push({ op: "advertise", ms: Number(process.hrtime.bigint() - started) / 1e6 });
        return;
      }

      if (url.pathname.endsWith("/git-upload-pack") && req.method === "POST") {
        const { repo } = await repoNow();
        const facts = await uploadPack({ req, res, repo, store });
        state.facts.push({ op: "upload-pack", ms: Number(process.hrtime.bigint() - started) / 1e6, ...facts });
        return;
      }

      if (url.pathname.endsWith("/git-receive-pack") && req.method === "POST") {
        const facts = await ops.receive({ req, res });
        state.facts.push({ op: "receive-pack", ms: Number(process.hrtime.bigint() - started) / 1e6, ...facts });
        return;
      }

      res.writeHead(404).end();
    } catch (err) {
      state.facts.push({ op: "error", path: url.pathname, error: String(err && err.stack ? err.stack : err).split("\n").slice(0, 3).join(" | ") });
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end(String(err.message || err));
    }
  });

  server.listen(config.port, "127.0.0.1", () => {
    console.log(JSON.stringify({ listening: server.address().port, pid: process.pid }));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
