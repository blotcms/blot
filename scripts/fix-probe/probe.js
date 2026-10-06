// Runs one of sync/fix's checks (tag-ghosts by default) against a blog,
// read-only, while watching the shared Redis connection it runs on, to find
// out whether the check's Redis traffic can hold up other commands on that
// connection for long enough to expire a sync's folder lock (10s TTL, renewed
// every 3s on the same connection - see app/sync/lock.js). Started by
// scripts/fix-probe/index.js (through scripts/probe/run.js) inside a one-off
// container of the image the app containers run - see README.md.
//
// Read-only: every command sent on the shared client must be on READ_COMMANDS
// (anything else is refused before it is queued), client.multi() and
// Entry.set are replaced with recorders that send nothing, and the summary
// lists the writes the check would have made.

const fs = require("fs");
const { performance } = require("perf_hooks");
const { parseArgs } = require("../probe/args");
const instrument = require("../probe/instrument");

const OPTIONS = {
  check: {
    value: "NAME",
    help: "the sync/fix check to run: tag-ghosts (default), entry-ghosts, list-ghosts, menu-ghosts, entries-path-index",
  },
  repeat: { value: "N", help: "run the check N times (default 1); later runs have a warm client-side cache" },
  "skip-stats": { help: "don't measure the blog's tags and entry sizes first" },
  "stats-only": { help: "only measure the blog's tags and entry sizes; don't run the check" },
  out: { value: "DIR" },
};

const CHECKS = ["tag-ghosts", "entry-ghosts", "list-ghosts", "menu-ghosts", "entries-path-index"];

const READ_COMMANDS = new Set([
  "GET", "MGET", "STRLEN", "EXISTS", "TYPE", "TTL", "PTTL",
  "SMEMBERS", "SISMEMBER", "SCARD", "SSCAN",
  "ZCARD", "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "ZSCORE", "ZRANK", "ZREVRANK", "ZSCAN",
  "HGET", "HMGET", "HGETALL", "HLEN", "HEXISTS", "HKEYS", "HSCAN",
  "LRANGE", "LLEN", "LINDEX", "SCAN", "PING",
]);
const READ_CLIENT_SUBCOMMANDS = new Set(["INFO", "ID", "LIST", "GETNAME", "TRACKINGINFO"]);

// How often each connection is pinged. A ping on the shared connection
// queues behind whatever the check has in flight, exactly as a lock
// heartbeat's EXTEND would; one on the control connection doesn't.
const PING_INTERVAL_MS = 100;
// Stall thresholds reported in the summary: the heartbeat's own slow log
// (app/sync/lock.js) and the folder lock's TTL.
const SLOW_MS = 500;
const LOCK_TTL_MS = 10 * 1000;

function checkOptions(args) {
  const check = args.check || "tag-ghosts";
  if (!CHECKS.includes(check)) throw new Error(`--check must be one of ${CHECKS.join(", ")}`);
  const repeat = args.repeat === undefined ? 1 : Number(args.repeat);
  if (!(Number.isInteger(repeat) && repeat >= 1)) throw new Error("--repeat must be a positive integer");
  if (args["stats-only"] && args["skip-stats"]) throw new Error("--stats-only and --skip-stats conflict");
  return { check, repeat, statsOnly: !!args["stats-only"], skipStats: !!args["skip-stats"] };
}

let config, client, control;

// Refuses anything but reads on the shared client. node-redis' createClient
// returns a proxy; every command (cached GET/MGET included) reaches Redis
// through _self.sendCommand. MULTI and pipelines skip it and write to the
// queue directly, so client.multi is replaced with a recorder.
function makeReadOnly(Entry) {
  const refused = {};
  const wouldWrite = {};
  const self = client._self;
  const sendCommand = self.sendCommand;
  self.sendCommand = function (args, options) {
    const name = String(args[0]).toUpperCase();
    const sub = String(args[1] || "").toUpperCase();
    if (!READ_COMMANDS.has(name) && !(name === "CLIENT" && READ_CLIENT_SUBCOMMANDS.has(sub))) {
      refused[name] = (refused[name] || 0) + 1;
      return Promise.reject(new Error(`fix-probe is read-only: refused ${name}`));
    }
    return sendCommand.call(this, args, options);
  };

  const record = (name) => (wouldWrite[name] = (wouldWrite[name] || 0) + 1);
  const recorder = () => {
    const multi = new Proxy(
      {},
      {
        get(target, property) {
          if (property === "exec" || property === "execAsPipeline") {
            return (callback) => {
              record("MULTI");
              if (typeof callback === "function") setImmediate(callback, null, []);
              return Promise.resolve([]);
            };
          }
          if (property === "then") return undefined;
          return () => {
            record(String(property).toUpperCase());
            return multi;
          };
        },
      }
    );
    return multi;
  };
  client.multi = client.MULTI = recorder;
  Entry.set = (blogID, id, entry, callback) => {
    record("Entry.set");
    setImmediate(callback, null);
  };

  return { refused, wouldWrite };
}

// Pings one connection every PING_INTERVAL_MS, never more than one at a time,
// so outstandingMs() is how long the current ping has waited.
function pinger(redis) {
  const stats = { count: 0, maxMs: 0, slow: 0, overTtl: 0, errors: 0, last: null };
  let sentAt = null;
  const timer = setInterval(() => {
    if (sentAt !== null) return;
    sentAt = performance.now();
    redis
      .ping()
      .then(
        () => {
          const ms = Math.round(performance.now() - sentAt);
          stats.count++;
          stats.last = ms;
          stats.maxMs = Math.max(stats.maxMs, ms);
          if (ms >= SLOW_MS) stats.slow++;
          if (ms >= LOCK_TTL_MS) stats.overTtl++;
        },
        () => stats.errors++
      )
      .finally(() => (sentAt = null));
  }, PING_INTERVAL_MS);
  timer.unref();
  return {
    stats,
    outstandingMs: () => (sentAt === null ? 0 : Math.round(performance.now() - sentAt)),
    stop: () => clearInterval(timer),
  };
}

// This process' TCP sockets to Redis, from the kernel's point of view:
// bytes queued to send (tx) and received but unread (rx), and retransmits.
function readTcp() {
  const port = Number(config.redis.port);
  const sockets = {};
  let text;
  try {
    text = fs.readFileSync("/proc/net/tcp", "utf8");
  } catch (e) {
    return { sockets };
  }
  for (const line of text.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;
    if (parseInt(parts[2].split(":")[1], 16) !== port) continue;
    const [tx, rx] = parts[4].split(":").map((n) => parseInt(n, 16));
    const localPort = parseInt(parts[1].split(":")[1], 16);
    sockets[localPort] = { tx, rx, timer: Number(parts[5].split(":")[0]), retransmits: parseInt(parts[6], 16) };
  }
  return { sockets };
}

function readRetransSegs() {
  try {
    const lines = fs.readFileSync("/proc/net/snmp", "utf8").split("\n").filter((l) => l.startsWith("Tcp:"));
    const names = lines[0].split(/\s+/);
    const values = lines[1].split(/\s+/);
    return Number(values[names.indexOf("RetransSegs")]);
  } catch (e) {
    return null;
  }
}

// Node's view of each Redis socket: bytes written and read, and what is
// buffered in Node waiting for the kernel (node-redis stops writing once
// writableNeedDrain is set and resumes on 'drain').
function nodeSockets() {
  const port = Number(config.redis.port);
  const sockets = {};
  for (const handle of process._getActiveHandles()) {
    if (!handle || handle.remotePort !== port) continue;
    sockets[handle.localPort] = {
      written: handle.bytesWritten,
      read: handle.bytesRead,
      buffered: handle.writableLength,
      needDrain: handle.writableNeedDrain,
    };
  }
  return sockets;
}

// The local ports of this process' Redis sockets, to tell the shared
// client's socket from the control connection's (Redis may see other ports
// through Docker's NAT, so CLIENT INFO can't be used).
function redisPorts() {
  return new Set(Object.keys(nodeSockets()).map(Number));
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    total,
    p50: percentile(sorted, 50),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] || 0,
  };
}

async function inBatches(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return results;
}

// The blog's shape as tag-ghosts sees it, read over the control connection
// (so the shared client's cache stays cold for the check): how many commands
// Tags.list queues at once, and how many bytes tag-ghosts' MGET batches pull.
async function tagStats(blogID, Tags, entryKey) {
  const started = performance.now();
  const slugs = (await control.sMembers(Tags.key.all(blogID))) || [];
  const members = await inBatches(slugs, 100, (slug) => control.zRange(Tags.key.sortedTag(blogID, slug), 0, -1));
  const unique = Array.from(new Set(members.flat()));
  const sizes = new Map();
  await inBatches(unique, 500, async (id) => sizes.set(id, await control.strLen(entryKey(blogID, id))));

  // Mirrors resolveEntryIDs in app/sync/fix/tag-ghosts.js: per tag, ids not
  // yet resolved are read in MGETs of 20; hits are memoised, misses are
  // re-read for every tag that holds them.
  const resolved = new Set();
  const batchBytes = [];
  for (const ids of members) {
    const unresolved = ids.filter((id) => !resolved.has(id));
    for (let i = 0; i < unresolved.length; i += 20) {
      const batch = unresolved.slice(i, i + 20);
      batchBytes.push(batch.reduce((n, id) => n + (sizes.get(id) || 0), 0));
      for (const id of batch) if (sizes.get(id)) resolved.add(id);
    }
  }

  const missing = unique.filter((id) => !sizes.get(id)).length;
  return {
    ms: Math.round(performance.now() - started),
    tags: slugs.length,
    tagsListCommandsAtOnce: slugs.length * 2,
    entriesPerTag: distribution(members.map((ids) => ids.length)),
    tagMemberships: members.reduce((n, ids) => n + ids.length, 0),
    uniqueEntries: unique.length,
    missingEntries: missing,
    entryBytes: distribution(unique.map((id) => sizes.get(id) || 0).filter(Boolean)),
    mgetBatches: distribution(batchBytes),
    largestEntries: unique
      .map((id) => ({ id, bytes: sizes.get(id) || 0 }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 10),
  };
}

function wrapAsync(object, name, out, label) {
  const original = object[name];
  object[name] = function (...args) {
    const callback = args[args.length - 1];
    if (typeof callback !== "function") return original.apply(this, args);
    const started = performance.now();
    args[args.length - 1] = function (err, result) {
      out.append("calls.ndjson", {
        t: instrument.now(),
        call: label,
        ms: Math.round(performance.now() - started),
        tag: typeof args[1] === "string" ? args[1] : undefined,
        results: Array.isArray(result) ? result.length : undefined,
        error: err ? String(err.message || err) : undefined,
      });
      callback.apply(this, arguments);
    };
    return original.apply(this, args);
  };
}

async function getBlog(Blog, identifier) {
  const lower = identifier.toLowerCase();
  const suffix = "." + config.host;
  const handle = lower.endsWith(suffix) ? lower.slice(0, -suffix.length).split(".").pop() : lower;
  for (const by of [{ id: identifier }, { handle }, { domain: lower }]) {
    const blog = await new Promise((done) => Blog.get(by, (err, blog) => done(err ? null : blog)));
    if (blog && blog.id) return blog;
  }
  throw new Error("No blog for " + identifier);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2), OPTIONS);
  const options = checkOptions(parsed.options);
  if (parsed.rest.length !== 1) throw new Error("Pass one blog: its ID, handle or domain");

  const out = instrument.output(parsed.options.out || "/out");
  // Loaded here rather than at the top, so the wrapper can require this
  // file for OPTIONS and checkOptions without the app.
  config = require("config");
  client = require("models/client");
  const Blog = require("models/blog");
  const Entry = require("models/entry");
  const Tags = require("models/tags");
  const entryKey = require("models/entry/key").entry;
  const { refused, wouldWrite } = makeReadOnly(Entry);

  // The shared client connects as models/client is loaded; once it has,
  // every Redis socket but the control connection's is the app's.
  await client.ping();
  const appPorts = redisPorts();
  control = require("models/redis").createLibraryClient("fix-probe-control");
  await control.ping();
  const controlPorts = Array.from(redisPorts()).filter((port) => !appPorts.has(port));

  const blog = await getBlog(Blog, parsed.rest[0]);
  const summary = { args: process.argv.slice(2), release: process.env.BLOT_RELEASE_ID, options, blogID: blog.id };
  console.log(`[probe] ${blog.id} (${blog.handle})`);

  if (!options.skipStats) {
    console.log("[probe] measuring tags and entry sizes over the control connection...");
    summary.stats = await tagStats(blog.id, Tags, entryKey);
    console.log("[probe] stats", JSON.stringify(summary.stats, null, 2));
  }

  if (!options.statsOnly) {
    // Counts the check's commands (and the pings), not the stats reads.
    const redisTotals = instrument.trackRedis({
      onCommand(scope, name, count, bytes, ms) {
        if (name === "MGET" || ms >= 100) {
          out.append("commands.ndjson", { t: instrument.now(), name, count, bytes, ms: Math.round(ms) });
        }
      },
    });
    // models/client is normally the app's only Redis socket in this process.
    const sharedPorts = Array.from(appPorts);
    const sharedPort = sharedPorts.length === 1 ? sharedPorts[0] : null;
    summary.sockets = { shared: sharedPorts, control: controlPorts };
    const queue = client._getQueue();
    const shared = pinger(client);
    const controlPing = pinger(control);
    const retransAtStart = readRetransSegs();
    let previous = nodeSockets();

    const sampler = instrument.startSampler(out, {
      extra() {
        const sockets = nodeSockets();
        const tcp = readTcp().sockets;
        const deltas = {};
        for (const port of Object.keys(sockets)) {
          const before = previous[port] || { written: 0, read: 0 };
          deltas[port] = {
            ...sockets[port],
            writtenDelta: sockets[port].written - before.written,
            readDelta: sockets[port].read - before.read,
            kernel: tcp[port],
          };
        }
        previous = sockets;
        return {
          pending: queue.pendingCount,
          waitingToWrite: queue.isWaitingToWrite(),
          sharedPingOutstandingMs: shared.outstandingMs(),
          sharedPingLastMs: shared.stats.last,
          controlPingOutstandingMs: controlPing.outstandingMs(),
          retransSegs: readRetransSegs(),
          shared: sharedPort === null ? undefined : deltas[sharedPort],
          // Every socket, if the shared one couldn't be singled out.
          ...(sharedPort === null ? { sockets: deltas } : {}),
        };
      },
      print(s) {
        const k = (s.shared && s.shared.kernel) || {};
        console.log(
          `[${(s.t / 1000).toFixed(1)}s] pending=${s.pending}${s.waitingToWrite ? " (unsent)" : ""}` +
            ` sharedPing=${s.sharedPingOutstandingMs || s.sharedPingLastMs}ms controlPing=${s.controlPingOutstandingMs}ms` +
            ` nodeBuffered=${s.shared ? s.shared.buffered : "?"} kernelTx=${k.tx ?? "?"} kernelRx=${k.rx ?? "?"}` +
            ` retrans=${s.retransSegs - retransAtStart} heap=${s.heapUsedMB}MB loopDelayMax=${s.eventLoopDelayMaxMs}ms`
        );
      },
    });

    const check = require("sync/fix/" + options.check);
    wrapAsync(Tags, "list", out, "Tags.list");
    wrapAsync(Tags, "get", out, "Tags.get");
    summary.runs = [];
    for (let run = 1; run <= options.repeat; run++) {
      const started = performance.now();
      const result = await new Promise((done) =>
        check(blog, (err, report) => done({ err, report }))
      );
      const ms = Math.round(performance.now() - started);
      console.log(`[probe] ${options.check} run ${run}: ${ms}ms${result.err ? " ERROR " + result.err.message : ""}`);
      summary.runs.push({
        ms,
        error: result.err ? String(result.err.stack || result.err) : undefined,
        reportItems: result.report ? result.report.length : undefined,
        reportSample: result.report ? result.report.slice(0, 20) : undefined,
      });
    }

    // Let the pingers finish what's outstanding before stopping them.
    await new Promise((resolve) => setTimeout(resolve, 2 * PING_INTERVAL_MS));
    shared.stop();
    controlPing.stop();
    sampler.stop();
    summary.sampler = sampler.summary();
    summary.sharedPing = shared.stats;
    summary.controlPing = controlPing.stats;
    summary.retransSegs = readRetransSegs() - retransAtStart;
    summary.redis = redisTotals.summary();
  }

  summary.refusedWrites = refused;
  summary.wouldWrite = wouldWrite;
  out.writeJSON("summary.json", summary);
  console.log("[probe] summary", JSON.stringify({ ...summary, stats: undefined }, null, 2));
  process.exit(0);
}

// The wrapper requires this file for OPTIONS, to check arguments locally.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { OPTIONS, checkOptions };
