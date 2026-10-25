#!/usr/bin/env node
// Rank client IP ranges in an openresty access log by egress and abuse signals.
//
//   node ranges.js access.log[.gz] [more logs...] [--top 20] [--cdn-ips file]
//
// Clients are grouped by IPv4 /24 or IPv6 /48 (scrapers rent a block, not one
// address). For each range: bytes sent and share of the log, request count,
// distinct IPs / user agents / hosts, and the status mix. Two rankings: by
// bytes (egress cost) and by error responses (repeat scanning), then a detail
// block for the top few by bytes: user agents, hosts and paths.
//
// Ranges whose addresses are all in the CDN edge list (--cdn-ips, a
// cdn-ips.conf with "ip 1;" lines; default: proxy/build/data/latest/cdn-ips.conf
// if it exists), private addresses and loopback are set aside and reported as
// one line, never ranked: banning them would take the site down.
//
// Output contains client IPs and hostnames. It is for the operator, in chat or
// the terminal, not for the repo, an issue or a PR.

const fs = require("fs");
const zlib = require("zlib");
const readline = require("readline");
const path = require("path");

const args = process.argv.slice(2);
const files = [];
let top = 20;
let cdnFile = path.resolve(__dirname, "../../../proxy/build/data/latest/cdn-ips.conf");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--top") top = Number(args[++i]);
  else if (args[i] === "--cdn-ips") cdnFile = args[++i];
  else files.push(args[i]);
}
if (!files.length) {
  console.error("usage: node ranges.js access.log[.gz] [...] [--top N] [--cdn-ips file]");
  process.exit(1);
}

const cdn = new Set();
if (fs.existsSync(cdnFile)) {
  for (const l of fs.readFileSync(cdnFile, "utf8").split("\n")) {
    const m = l.match(/^\s*([0-9a-fA-F.:]+)\s+1;/);
    if (m) cdn.add(m[1]);
  }
} else {
  console.error("warning: no CDN IP list at " + cdnFile + "; CDN edges will be ranked");
}

const LINE =
  /^\[([^\]]+)\] \S+ (\d+) \S+ (\d+):(\d+) (\S+)\s+cache=(\S*) ip=(\S+) .*? ua=(.*?)(?: ae=[^ ]*)?$/;

function isPrivate(ip) {
  return (
    ip === "::1" || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ||
    /^(fc|fd|fe80:)/i.test(ip)
  );
}

function expandV6(ip) {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = ip.includes("::") ? 8 - h.length - t.length : 0;
  return h.concat(Array(fill).fill("0"), t).map((x) => x.padStart(4, "0"));
}

function rangeOf(ip) {
  if (ip.includes(":")) return expandV6(ip).slice(0, 3).join(":") + "::/48";
  const o = ip.split(".");
  return o.slice(0, 3).join(".") + ".0/24";
}

// Collapse version tokens, hex ids and numbers so repeats of one kind of URL
// group together.
function normalisePath(p) {
  return p
    .replace(/\?.*/, "")
    .replace(/\/v-[0-9a-f]+\//g, "/v-*/")
    .replace(/[0-9a-f]{16,}/gi, "*")
    .replace(/\d+/g, "N")
    .slice(0, 70);
}

function open(file) {
  let stream = fs.createReadStream(file);
  if (file.endsWith(".gz")) stream = stream.pipe(zlib.createGunzip());
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

async function each(fn) {
  for (const f of files) for await (const line of open(f)) fn(line);
}

const ranges = new Map();
let total = 0,
  totalReqs = 0,
  cdnBytes = 0,
  privBytes = 0,
  first = null,
  last = null;

function bucket(status) {
  if (status === 200 || status === 206) return "ok";
  if (status === 304) return "notmod";
  if (status >= 300 && status < 400) return "redir";
  if (status === 404) return "404";
  if (status === 403 || status === 429 || status === 444) return "blocked";
  return "other";
}

function inc(m, k, v) {
  m.set(k, (m.get(k) || 0) + v);
}

(async () => {
  await each((line) => {
    const m = LINE.exec(line);
    if (!m) return;
    const [, time, status, , sent, url, cache, ip, ua] = m;
    const bytes = Number(sent);
    first = first || time;
    last = time;
    total += bytes;
    totalReqs++;
    if (isPrivate(ip)) return void (privBytes += bytes);
    if (cdn.has(ip)) return void (cdnBytes += bytes);
    const key = rangeOf(ip);
    let r = ranges.get(key);
    if (!r) {
      r = { bytes: 0, reqs: 0, ips: new Set(), uas: new Set(), hosts: new Set(), st: {}, hit: 0 };
      ranges.set(key, r);
    }
    r.bytes += bytes;
    r.reqs++;
    r.ips.add(ip);
    if (r.uas.size < 200) r.uas.add(ua);
    r.hosts.add(url.split("/")[2]);
    const b = bucket(Number(status));
    r.st[b] = (r.st[b] || 0) + 1;
    if (cache === "HIT") r.hit++;
  });

  const mb = (n) => (n / 1e6).toFixed(0).padStart(6);
  const pct = (n, d) => (d ? ((100 * n) / d).toFixed(0) : "0").padStart(3) + "%";
  console.log(`window: ${first} .. ${last}`);
  console.log(
    `total ${(total / 1e6).toFixed(0)} MB / ${totalReqs} requests; CDN edges ${(cdnBytes / 1e6).toFixed(0)} MB and private ${(privBytes / 1e6).toFixed(0)} MB set aside\n`
  );

  const rows = [...ranges.entries()];
  const head =
    "range                      MB  share   reqs  avgKB  ips uas hosts   ok 404 blk  hit";
  const fmt = ([k, r]) =>
    k.padEnd(22) +
    mb(r.bytes) +
    pct(r.bytes, total).padStart(7) +
    String(r.reqs).padStart(7) +
    (r.bytes / 1e3 / r.reqs).toFixed(0).padStart(7) +
    String(r.ips.size).padStart(5) +
    String(r.uas.size).padStart(4) +
    String(r.hosts.size).padStart(6) +
    pct(r.st.ok || 0, r.reqs).padStart(7) +
    pct(r.st["404"] || 0, r.reqs).padStart(4) +
    pct(r.st.blocked || 0, r.reqs).padStart(4) +
    pct(r.hit, r.reqs).padStart(5);

  console.log("== by bytes sent");
  console.log(head);
  const byBytes = rows.sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top);
  byBytes.forEach((e) => console.log(fmt(e)));

  console.log("\n== by 404/blocked responses (repeat scanning; min 200)");
  console.log(head);
  rows
    .map((e) => [e, (e[1].st["404"] || 0) + (e[1].st.blocked || 0)])
    .filter(([, n]) => n >= 200)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .forEach(([e]) => console.log(fmt(e)));

  // Detail pass for the top few by bytes
  const detailKeys = new Set(byBytes.slice(0, 6).map(([k]) => k));
  const detail = new Map([...detailKeys].map((k) => [k, { ua: new Map(), host: new Map(), path: new Map() }]));
  await each((line) => {
    const m = LINE.exec(line);
    if (!m) return;
    const ip = m[7];
    if (isPrivate(ip) || cdn.has(ip)) return;
    const d = detail.get(rangeOf(ip));
    if (!d) return;
    const bytes = Number(m[4]);
    const u = m[5].replace(/^https?:\/\//, "");
    const slash = u.indexOf("/");
    inc(d.ua, m[8].slice(0, 90), bytes);
    inc(d.host, u.slice(0, slash < 0 ? undefined : slash), bytes);
    inc(d.path, normalisePath(slash < 0 ? "/" : u.slice(slash)), bytes);
  });
  for (const [k, d] of detail) {
    console.log(`\n== ${k}`);
    for (const [name, map] of [["user agents", d.ua], ["hosts", d.host], ["paths", d.path]]) {
      console.log(`  ${name}:`);
      [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([x, n]) =>
        console.log(`   ${(n / 1e6).toFixed(0).padStart(5)} MB  ${x}`)
      );
    }
  }
})();
