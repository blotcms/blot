#!/usr/bin/env node
// Triage slow upstream responses in an openresty access log.
//
//   node triage.js access.log[.gz] [more logs...] [--threshold 0.1] [--top 30]
//   node triage.js access.log.gz --detail www.example.com   (one host's slow requests)
//   node triage.js access.log.gz --at 09:41:07 [--window 20] (everything on the
//     upstream around a moment, to see what else was in flight)
//   --since 08:41:00   only requests that ended at or after this UTC time (e.g.
//     when the app containers last started, so app logs cover every request)
//
// st= is $upstream_response_time: how long the node container took, from
// nginx's side, to answer. It includes time the request spent queued behind
// a blocked event loop, so a slow st alone doesn't make a request slow. This
// script separates:
//
//   - long-lived routes (SSE, long polls, webhook receivers, git pushes) that
//     are slow by design;
//   - stall clusters: overlapping slow requests on one upstream, usually one
//     expensive request (the suspect: started first, or longest) plus the
//     unrelated requests that queued behind it;
//   - URL groups ranked by total time over the threshold, with how often the
//     same URL was fast, to tell a regularly pathological request from a
//     one-off.

const fs = require("fs");
const zlib = require("zlib");
const readline = require("readline");

const UPSTREAMS = { "8088": "blue", "8089": "green", "8090": "yellow" };

// Slow by design. Matched against host + path (no scheme, no query).
const LONG_LIVED = [
  [/^(www\.)?blot\.im\/sites\/[^/]+\/(import\/)?status$/, "dashboard SSE"],
  [/^webhooks\.blot\.im\//, "webhook relay SSE"],
  [/\/draft\/stream\//, "draft preview SSE"],
  [/\/__blot\/preview\/reload$/, "template preview SSE"],
];

// Do real work inline, so are slow by nature. Reported, not ranked.
const INHERENT = [
  [/^(www\.)?blot\.im\/clients\/(google-drive|dropbox)\/webhook/, "client webhook"],
  [/^(www\.)?blot\.im\/clients\/git\//, "git push"],
  [/^(www\.)?blot\.im\/(stripe|paypal)-webhook/, "payment webhook"],
  [/^(www\.)?blot\.im\/sites\/[^/]+\/(client\/reset\/rebuild|import)(\/|$)/, "rebuild/import"],
  [/^(www\.)?blot\.im\/sites\/[^/]+\/client\/[^/]+\/authenticate/, "client OAuth"],
];

const LINE =
  /^\[(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) [^\]]+\] (\S+) (\d+) (\S+) \S+ (\S+)\s+cache=(\S*) ip=(\S+) st=(.*?) lrs=\S* up=(.*?) ua=(.*)$/;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function parseArgs(argv) {
  const opts = { files: [], threshold: 0.1, top: 30, window: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--threshold") opts.threshold = parseFloat(argv[++i]);
    else if (a === "--top") opts.top = parseInt(argv[++i], 10);
    else if (a === "--detail") opts.detail = argv[++i];
    else if (a === "--at") opts.at = argv[++i];
    else if (a === "--window") opts.window = parseFloat(argv[++i]);
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else opts.files.push(a);
  }
  return opts;
}

function classify(hostPath) {
  for (const [re, label] of LONG_LIVED) if (re.test(hostPath)) return { kind: "long-lived", label };
  for (const [re, label] of INHERENT) if (re.test(hostPath)) return { kind: "inherent", label };
  return { kind: "page", label: "" };
}

// Collapse IDs and dates so /2021/03/04/foo and /2022/01/02/bar share a
// route, while keeping the first path segment readable.
function route(path) {
  return (
    path
      .replace(/\/page\/\d+/, "/page/N")
      .replace(/\/\d{4}\/\d{1,2}(\/\d{1,2})?\/[^/]+/, "/YYYY/MM/slug")
      .replace(/\/(blog|site)_[0-9a-f]{32}/g, "/$1_ID")
      .replace(/\/v-[0-9a-f]{8}/g, "/v-HASH")
      .replace(/\/[0-9a-f]{16,}/g, "/HEX")
      .replace(/\/\d+(?=\/|$)/g, "/N") || "/"
  );
}

function parseLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  const [, d, mon, y, H, M, S, id, status, rt, url, cache, ip, st, up, ua] = m;
  if (st.trim() === "-") return null;
  // Retries across upstreams: "0.088, 0.049"; internal redirects: "0.1 : 0.2".
  const parts = st.split(/\s*[,:]\s*/).map(parseFloat).filter((n) => !isNaN(n));
  if (!parts.length) return null;
  const upstreams = up.split(/\s*[,:]\s*/).map((u) => UPSTREAMS[u.split(":").pop()] || u);
  const end = Date.UTC(+y, MONTHS[mon], +d, +H, +M, +S) / 1000;
  const total = parts.reduce((a, b) => a + b, 0);
  const noQuery = url.replace(/^https?:\/\//, "").replace(/[?#].*$/, "");
  const slash = noQuery.indexOf("/");
  const host = slash === -1 ? noQuery : noQuery.slice(0, slash);
  const path = slash === -1 ? "/" : noQuery.slice(slash);
  return {
    time: `${H}:${M}:${S}`,
    end,
    start: end - total,
    id,
    status: +status,
    rt: parseFloat(rt),
    url,
    host,
    path,
    hostPath: host + path,
    cache,
    ip,
    st: total,
    stParts: parts,
    upstream: upstreams[upstreams.length - 1],
    upstreams,
    ua,
  };
}

async function read(files, onRecord) {
  for (const file of files) {
    let stream = fs.createReadStream(file);
    if (file.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      const r = parseLine(line);
      if (r) onRecord(r);
    }
  }
}

const pct = (a, b) => (b ? ((a * 100) / b).toFixed(1) + "%" : "-");
const ms = (s) => (s >= 10 ? s.toFixed(0) + "s" : s >= 1 ? s.toFixed(1) + "s" : Math.round(s * 1000) + "ms");
function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function shortUA(ua) {
  const bot = /([A-Za-z-]*(bot|crawler|spider|fetch|feed|reader)[A-Za-z-]*)/i.exec(ua);
  if (bot) return bot[1];
  return ua.split(/[ (]/)[0].slice(0, 24);
}

// Merge overlapping slow requests per upstream into clusters.
function clusters(slow) {
  const byUp = {};
  for (const r of slow) (byUp[r.upstream] = byUp[r.upstream] || []).push(r);
  const out = [];
  for (const [up, rs] of Object.entries(byUp)) {
    rs.sort((a, b) => a.start - b.start);
    let cur = null;
    for (const r of rs) {
      // 1s slack: end times are only logged to the second.
      if (cur && r.start <= cur.end + 1) {
        cur.reqs.push(r);
        cur.end = Math.max(cur.end, r.end);
      } else {
        cur = { upstream: up, start: r.start, end: r.end, reqs: [r] };
        out.push(cur);
      }
    }
  }
  for (const c of out) {
    c.hosts = new Set(c.reqs.map((r) => r.host));
    // Suspect: the longest request. Ties go to the one that started first.
    c.suspect = c.reqs.slice().sort((a, b) => b.st - a.st || a.start - b.start)[0];
    for (const r of c.reqs) r.cluster = c;
  }
  return out;
}

function fmtTime(sec) {
  return new Date(sec * 1000).toISOString().slice(11, 19);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.files.length) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n\n")[0].replace(/^#.*\n/, "").replace(/^\/\/ ?/gm, ""));
    return;
  }

  let all = [];
  await read(opts.files, (r) => all.push(r));
  if (opts.since) all = all.filter((r) => r.time >= opts.since);
  if (!all.length) return console.log("No upstream requests found.");

  if (opts.at) {
    const [H, M, S] = opts.at.split(":").map(Number);
    const day = new Date(all[0].end * 1000);
    let t = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), H, M, S || 0) / 1000;
    const near = all
      .filter((r) => r.end >= t - opts.window && r.start <= t + opts.window)
      .sort((a, b) => a.start - b.start);
    console.log(`Upstream requests in flight within ${opts.window}s of ${opts.at} UTC (start → end, st):\n`);
    for (const r of near)
      console.log(
        `${fmtTime(r.start)}→${r.time} ${ms(r.st).padStart(6)} ${r.upstream.padEnd(6)} ${r.status} ${r.id} ${r.url.slice(0, 110)} cache=${r.cache} ua=${shortUA(r.ua)}`
      );
    return;
  }

  const slow = all.filter((r) => r.st >= opts.threshold);
  const kinds = { "long-lived": [], inherent: [], page: [] };
  for (const r of slow) {
    const c = classify(r.hostPath);
    r.kind = c.kind;
    r.label = c.label;
    kinds[c.kind].push(r);
  }
  const pages = kinds.page;
  const cls = clusters(pages);

  if (opts.detail) {
    const rs = all.filter((r) => r.host === opts.detail).sort((a, b) => b.st - a.st);
    console.log(`${opts.detail}: ${rs.length} upstream requests, ${rs.filter((r) => r.st >= opts.threshold).length} slow, median ${ms(median(rs.map((r) => r.st)))}\n`);
    for (const r of rs.filter((r) => r.st >= opts.threshold).slice(0, 60)) {
      const c = r.cluster;
      const tag = !c || c.reqs.length === 1 ? "alone" : c.suspect === r ? `SUSPECT of ${c.reqs.length}` : `queued (${c.reqs.length} in cluster, suspect ${c.suspect.host})`;
      console.log(`${r.time} ${ms(r.st).padStart(6)} ${r.upstream} ${r.status} ${r.id} ${r.path.slice(0, 80)} cache=${r.cache} ua=${shortUA(r.ua)} [${tag}]`);
    }
    return;
  }

  const first = all.reduce((a, r) => Math.min(a, r.end), Infinity);
  const last = all.reduce((a, r) => Math.max(a, r.end), 0);
  console.log(`Window ${new Date(first * 1000).toISOString()} → ${new Date(last * 1000).toISOString()}`);
  console.log(`Upstream requests: ${all.length}; st ≥ ${ms(opts.threshold)}: ${slow.length} (${pct(slow.length, all.length)})`);
  const byUp = {};
  for (const r of all) {
    const u = (byUp[r.upstream] = byUp[r.upstream] || { n: 0, slow: 0, sts: [] });
    u.n++;
    u.sts.push(r.st);
    if (r.st >= opts.threshold && classify(r.hostPath).kind === "page") u.slow++;
  }
  for (const [u, v] of Object.entries(byUp))
    console.log(`  ${u.padEnd(7)} ${String(v.n).padStart(7)} requests, median ${ms(median(v.sts))}, slow (excl. long-lived/inherent) ${pct(v.slow, v.n)}`);
  const buckets = [0.25, 1, 5, 15, Infinity];
  const counts = buckets.map(() => 0);
  for (const r of pages) counts[buckets.findIndex((b) => r.st < b)]++;
  console.log(`  slow page requests by st: <250ms ${counts[0]}, <1s ${counts[1]}, <5s ${counts[2]}, <15s ${counts[3]}, ≥15s ${counts[4]}`);

  console.log(`\n## Set aside: long-lived (slow by design) and inherently slow routes`);
  const set = {};
  for (const r of kinds["long-lived"].concat(kinds.inherent)) {
    const k = `${r.kind}: ${r.label}`;
    const s = (set[k] = set[k] || { n: 0, sts: [], max: 0 });
    s.n++;
    s.sts.push(r.st);
    s.max = Math.max(s.max, r.st);
  }
  for (const [k, s] of Object.entries(set).sort((a, b) => b[1].n - a[1].n))
    console.log(`  ${k.padEnd(36)} ${String(s.n).padStart(5)} slow, median ${ms(median(s.sts))}, max ${ms(s.max)}`);

  console.log(`\n## Stall clusters (≥3 overlapping slow page requests on one upstream)`);
  console.log(`  Requests that queued behind the suspect show their own host's st inflated.`);
  const big = cls.filter((c) => c.reqs.length >= 3).sort((a, b) => b.reqs.length - a.reqs.length);
  const inBig = big.reduce((a, c) => a + c.reqs.length, 0);
  console.log(`  ${big.length} clusters covering ${inBig} of ${pages.length} slow page requests\n`);
  for (const c of big.slice(0, opts.top)) {
    const s = c.suspect;
    console.log(
      `  ${fmtTime(c.start)}–${fmtTime(c.end)} ${c.upstream.padEnd(6)} ${String(c.reqs.length).padStart(3)} reqs / ${String(c.hosts.size).padStart(2)} hosts; suspect ${ms(s.st)} ${s.status} ${s.id} ${s.url.slice(0, 90)} ua=${shortUA(s.ua)}`
    );
  }

  // Group by host + route; rank by total excess time.
  const groups = {};
  for (const r of all) {
    if (classify(r.hostPath).kind !== "page") continue;
    const k = r.host + route(r.path);
    const g = (groups[k] = groups[k] || { key: k, host: r.host, n: 0, slow: [], sts: [] });
    g.n++;
    g.sts.push(r.st);
    if (r.st >= opts.threshold) g.slow.push(r);
  }
  const ranked = Object.values(groups)
    .filter((g) => g.slow.length)
    .map((g) => {
      g.excess = g.slow.reduce((a, r) => a + r.st - opts.threshold, 0);
      g.alone = g.slow.filter((r) => r.cluster.reqs.length === 1 || r.cluster.suspect === r).length;
      return g;
    })
    .sort((a, b) => b.excess - a.excess);

  console.log(`\n## URL groups ranked by total time over ${ms(opts.threshold)}`);
  console.log(`  own = slow requests that were alone or the suspect of their cluster (likely its own cost);`);
  console.log(`  the rest overlapped a slower request on the same upstream (likely queued).\n`);
  console.log(`  ${"excess".padStart(7)} ${"slow/all".padStart(9)} ${"own".padStart(4)} ${"median".padStart(6)} ${"max".padStart(6)}  route  [cache, top UA]`);
  for (const g of ranked.slice(0, opts.top)) {
    const caches = {};
    const uas = {};
    for (const r of g.slow) {
      caches[r.cache] = (caches[r.cache] || 0) + 1;
      const u = shortUA(r.ua);
      uas[u] = (uas[u] || 0) + 1;
    }
    const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}×${v}`).join(" ");
    const max = Math.max(...g.slow.map((r) => r.st));
    console.log(
      `  ${ms(g.excess).padStart(7)} ${(g.slow.length + "/" + g.n).padStart(9)} ${String(g.alone).padStart(4)} ${ms(median(g.sts)).padStart(6)} ${ms(max).padStart(6)}  ${g.key.slice(0, 80)}  [${top(caches)}, ${top(uas)}]`
    );
  }

  const hosts = {};
  for (const g of Object.values(groups)) {
    const h = (hosts[g.host] = hosts[g.host] || { n: 0, slow: 0, own: 0, sts: [] });
    h.n += g.n;
    h.slow += g.slow.length;
    h.own += g.slow.filter((r) => r.cluster && (r.cluster.reqs.length === 1 || r.cluster.suspect === r)).length;
    h.sts.push(...g.sts);
  }
  console.log(`\n## Hosts with ≥20 upstream requests, by share of slow requests`);
  Object.entries(hosts)
    .filter(([, h]) => h.n >= 20 && h.slow)
    .sort((a, b) => b[1].slow / b[1].n - a[1].slow / a[1].n)
    .slice(0, opts.top)
    .forEach(([k, h]) =>
      console.log(`  ${pct(h.slow, h.n).padStart(6)} ${(h.slow + "/" + h.n).padStart(9)} own ${String(h.own).padStart(4)} median ${ms(median(h.sts)).padStart(6)}  ${k}`)
    );
}

module.exports = { parseLine, classify, read, median, ms, shortUA };

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
