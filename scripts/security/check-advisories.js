#!/usr/bin/env node
// Daily check: is a runtime or OS we depend on behind on a security release,
// or past (or close to) end-of-life? Reads the pins from the repo, fetches
// public sources (nodejs.org, endoflife.date, nginx.org, GitHub, Amazon Linux
// security bulletins), compares, and prints a short report.
//
//   node scripts/security/check-advisories.js [--days N] [--json]
//        [--npm] [--dependabot]
//
//   --days N       ALAS look-back window (default 2)
//   --json         machine-readable output
//   --npm          also run `npm audit --omit=dev` in the repo root
//   --dependabot   also summarise open Dependabot alerts via `gh api`
//
// Exit code 1 if anything is in ACTION NEEDED, else 0. Every source is
// fetched independently with a timeout; a failing one is reported as
// "source unavailable" and the rest continue. Only public URLs are used
// (plus the optional local npm/gh calls). See
// .claude/skills/check-security-advisories/SKILL.md.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const FETCH_TIMEOUT_MS = 15000;
const EOL_WARN_DAYS = 60;
const WATCHED_PACKAGES = [
  "kernel", "docker", "containerd", "runc", "openssh", "openssl",
  "glibc", "sudo", "redis6", "systemd", "curl",
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const daysIdx = args.indexOf("--days");
const DAYS = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 2 : 2;
const AS_JSON = flag("--json");

const findings = { action: [], watch: [], ok: [], unavailable: [] };
const add = (level, msg) => findings[level].push(msg);

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch (e) {
    return null;
  }
}

async function get(url, headers) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: Object.assign({ "user-agent": "blot-check-advisories" }, headers),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res;
}

// Runs a source check; any thrown error becomes "source unavailable".
async function source(name, fn) {
  try {
    await fn();
  } catch (e) {
    add("unavailable", name + ": source unavailable (" + (e.message || e) + ")");
  }
}

function parseVer(v) {
  const m = String(v).match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? m.slice(1).map((n) => Number(n || 0)) : null;
}

function cmp(a, b) {
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 4; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

const today = new Date();
const daysUntil = (d) => Math.ceil((new Date(d) - today) / 86400000);

// EOL value from endoflife.date is false, true, or a date string.
function eolStatus(label, eol) {
  if (eol === false || eol == null) return add("ok", label + ": no EOL date set");
  if (eol === true) return add("action", label + ": end-of-life");
  const d = daysUntil(eol);
  if (d < 0) add("action", label + ": EOL passed on " + eol);
  else if (d <= EOL_WARN_DAYS) add("watch", label + ": EOL in " + d + " days (" + eol + ")");
  else add("ok", label + ": EOL " + eol + " (" + d + " days)");
}

async function eolApi(product) {
  return (await get("https://endoflife.date/api/" + product + ".json")).json();
}

// ---- pins -----------------------------------------------------------------

const pins = {};

function readPins() {
  const dockerfile = read("Dockerfile") || "";
  const m = dockerfile.match(/^ARG\s+NODE_BASE=node:([\w.]+?)-alpine/m);
  if (m) pins.node = m[1];
  const p = dockerfile.match(/^ARG\s+PANDOC_VERSION=(\S+)/m);
  if (p) pins.pandoc = p[1];

  const proxy = read("proxy/Dockerfile") || "";
  const ver = proxy.match(/^ARG\s+OPENRESTY_VERSION=(\S+)/m);
  const ngx = proxy.match(/^ARG\s+NGINX_VERSION=(\S+)/m);
  if (ver) pins.openresty = ver[1];
  if (ngx) pins.nginx = ngx[1];

  // The app and proxy images must share one node:alpine base (the proxy
  // builds OpenResty on it); a drift means one of them is behind.
  for (const problem of require("./check-base-image").problems()) add("action", "Base image: " + problem);

  const airlock = read("config/airlock/Dockerfile") || "";
  const a = airlock.match(/^FROM\s+alpine:([\w.]+)/m);
  if (a) pins.airlockAlpine = a[1];
}

// ---- checks ---------------------------------------------------------------

async function checkNode() {
  if (!pins.node) return add("watch", "Node: could not find ARG NODE_BASE=node:<ver>-alpine in Dockerfile");
  const floating = !/^\d+\.\d+\.\d+$/.test(pins.node);
  const major = pins.node.split(".")[0];
  if (floating) {
    add("watch", "Node: Dockerfile uses floating tag node:" + pins.node + "-alpine (not pinned; rebuild picks up latest)");
  }

  await source("Node releases (nodejs.org/dist/index.json)", async () => {
    const releases = await (await get("https://nodejs.org/dist/index.json")).json();
    const line = releases.filter((r) => r.version.startsWith("v" + major + "."));
    if (!line.length) throw new Error("no releases for major " + major);
    const latest = line[0].version.slice(1);
    if (floating) {
      add("ok", "Node " + major + ": latest is " + latest);
    } else {
      const newer = line.filter((r) => cmp(r.version.slice(1), pins.node) > 0);
      const sec = newer.filter((r) => r.security);
      if (sec.length) {
        add("action", "Node: pinned " + pins.node + " but security release(s) available: " +
          sec.map((r) => r.version.slice(1)).join(", ") + " (latest " + latest + ")");
      } else if (newer.length) {
        add("watch", "Node: pinned " + pins.node + ", newer non-security release " + latest);
      } else {
        add("ok", "Node " + pins.node + " is the latest " + major + ".x release");
      }
    }
    // Other maintained majors with a security release in the last N days,
    // for context only (we do not run them).
    const recentSec = releases.filter((r) => r.security &&
      (today - new Date(r.date)) / 86400000 <= Math.max(DAYS, 7));
    if (recentSec.length) {
      add("watch", "Node: security releases in the last " + Math.max(DAYS, 7) + " days: " +
        recentSec.map((r) => r.version + " (" + r.date + ")").join(", "));
    }
  });

  await source("Node schedule (nodejs/Release schedule.json)", async () => {
    const sched = await (await get("https://raw.githubusercontent.com/nodejs/Release/main/schedule.json")).json();
    const s = sched["v" + major];
    if (!s) throw new Error("no schedule entry for v" + major);
    eolStatus("Node " + major + " (schedule.json)", s.end);
  });

  await source("endoflife.date nodejs", async () => {
    const rows = await eolApi("nodejs");
    const r = rows.find((x) => String(x.cycle) === major);
    if (r) eolStatus("Node " + major + " (endoflife.date)", r.eol);
  });
}

async function checkAlpine() {
  await source("endoflife.date alpine-linux", async () => {
    const rows = await eolApi("alpine-linux");
    if (pins.airlockAlpine) {
      const cycle = pins.airlockAlpine.split(".").slice(0, 2).join(".");
      const r = rows.find((x) => String(x.cycle) === cycle);
      if (!r) return add("watch", "Alpine " + cycle + " (airlock) not found on endoflife.date");
      eolStatus("Alpine " + cycle + " (airlock image)", r.eol);
      if (cmp(rows[0].latest, r.latest) > 0) {
        add("watch", "Alpine: newest is " + rows[0].latest + "; airlock pinned to " + cycle + " (latest patch " + r.latest + ")");
      }
    }
    add("ok", "Alpine app-image base comes from the node:*-alpine image (tracks the Node pin)");
  });
}

async function checkAmazonLinux() {
  await source("endoflife.date amazon-linux", async () => {
    const rows = await eolApi("amazon-linux");
    for (const [cycle, use] of [["2", "app/proxy host"], ["2023", "Redis host"]]) {
      const r = rows.find((x) => String(x.cycle) === cycle);
      if (r) eolStatus("Amazon Linux " + cycle + " (" + use + ")", r.eol);
    }
  });
}

async function checkRedis() {
  // The Redis host runs the AL2023 redis6 package, not a pinned version, so
  // the upstream EOL date is context only and ALAS is the real signal.
  await source("endoflife.date redis", async () => {
    const rows = await eolApi("redis");
    const r = rows.find((x) => String(x.cycle) === "6.2" || String(x.cycle) === "6");
    if (r) {
      const d = r.eol && r.eol !== true ? daysUntil(r.eol) : null;
      const msg = "Redis " + r.cycle + " upstream EOL: " + r.eol + " (host uses AL2023 redis6 package; covered by ALAS)";
      add(r.eol === true || (d !== null && d < 0) ? "watch" : "ok", msg);
    }
  });
}

async function checkNginxAndOpenresty() {
  if (pins.nginx) {
    await source("endoflife.date nginx", async () => {
      const rows = await eolApi("nginx");
      add("ok", "nginx latest per endoflife.date: " + rows[0].latest + " (pinned " + pins.nginx + ")");
    });
    await source("nginx security advisories (nginx.org)", async () => {
      const html = await (await get("https://nginx.org/en/security_advisories.html")).text();
      const items = html.match(/<li><p>[\s\S]*?<\/p><\/li>/g) || [];
      if (!items.length) throw new Error("could not parse advisories page");
      const hits = [];
      for (const li of items) {
        const title = (li.match(/<p>([^<]+)</) || [])[1] || "advisory";
        const sev = (li.match(/Severity:\s*(\w+)/) || [])[1] || "?";
        const cve = (li.match(/CVE-\d+-\d+/) || [])[0] || "";
        const vuln = (li.match(/Vulnerable:\s*([^<]+)/) || [])[1] || "";
        const ranges = vuln.split(",").map((s) => s.trim()).filter(Boolean);
        const affected = ranges.some((r) => {
          const [lo, hi] = r.split("-");
          if (!hi) return cmp(pins.nginx, lo) === 0;
          return cmp(pins.nginx, lo) >= 0 && cmp(pins.nginx, hi) <= 0; // NaN (unparsable) -> false
        });
        if (affected) hits.push({ title, sev, cve });
      }
      if (hits.length) {
        const high = hits.some((h) => /high|critical/i.test(h.sev));
        add(high ? "action" : "watch",
          "nginx " + pins.nginx + " is within the Vulnerable range of " + hits.length + " advisories (" +
          hits.slice(0, 6).map((h) => h.cve + " " + h.sev).join(", ") +
          (hits.length > 6 ? ", ..." : "") + "); check whether the OpenResty bundle ships a patched nginx and whether the module is in use");
      } else {
        add("ok", "nginx " + pins.nginx + " is in no listed Vulnerable range");
      }
    });
  }

  if (pins.openresty) {
    await source("OpenResty tags (GitHub)", async () => {
      const tags = await (await get("https://api.github.com/repos/openresty/openresty/tags?per_page=30",
        { accept: "application/vnd.github+json" })).json();
      const vers = tags.map((t) => t.name.replace(/^v/, "")).filter((v) => /^\d+\.\d+\.\d+\.\d+$/.test(v))
        .sort((a, b) => cmp(b, a));
      if (!vers.length) throw new Error("no tags");
      if (cmp(vers[0], pins.openresty) > 0) {
        add("watch", "OpenResty: pinned " + pins.openresty + ", newest tag " + vers[0] + " (read release notes for security fixes)");
      } else {
        add("ok", "OpenResty " + pins.openresty + " is the newest tag");
      }
    });
  }
}

function pandocNote() {
  // endoflife.date has no pandoc product; compare against GitHub.
  if (!pins.pandoc) return;
  return source("Pandoc latest release (GitHub)", async () => {
    const rel = await (await get("https://api.github.com/repos/jgm/pandoc/releases/latest",
      { accept: "application/vnd.github+json" })).json();
    const latest = rel.tag_name;
    if (cmp(latest, pins.pandoc) > 0) add("watch", "Pandoc: pinned " + pins.pandoc + ", latest " + latest);
    else add("ok", "Pandoc " + pins.pandoc + " is the latest release");
  });
}

function parseRss(xml) {
  return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map((it) => {
    const title = (it.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
    const m = title.match(/^(\S+)\s+\((\w+)\):\s*(.*)$/);
    return {
      id: m ? m[1] : title,
      severity: m ? m[2].toLowerCase() : "?",
      pkg: m ? m[3].trim() : "",
      date: new Date((it.match(/<pubDate>([^<]*)<\/pubDate>/) || [])[1] || 0),
      link: (it.match(/<link>([^<]*)<\/link>/) || [])[1] || "",
      cves: ((it.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "").trim().split(/\s*,\s*/).filter(Boolean),
    };
  });
}

async function checkAlas() {
  for (const [name, url, where] of [
    ["AL2", "https://alas.aws.amazon.com/AL2/alas.rss", "app/proxy host"],
    ["AL2023", "https://alas.aws.amazon.com/AL2023/alas.rss", "Redis host"],
  ]) {
    await source("Amazon Linux " + name + " bulletins", async () => {
      const items = parseRss(await (await get(url)).text());
      if (!items.length) throw new Error("could not parse feed");
      const cutoff = Date.now() - DAYS * 86400000;
      const recent = items.filter((i) => i.date.getTime() >= cutoff);
      let hot = 0, other = 0;
      for (const i of recent) {
        const watched = WATCHED_PACKAGES.some((w) =>
          i.pkg === w || i.pkg.split(/[\s,]+/).includes(w) || (w === "kernel" && /^kernel/.test(i.pkg)));
        const sevHigh = i.severity === "critical" || i.severity === "important";
        const line = name + " " + i.id + " (" + i.severity + "): " + i.pkg + " [" + i.cves.length + " CVEs] " + i.link;
        if (watched && sevHigh) { add("action", line + " -> " + where); hot++; }
        else if (watched) { add("watch", line); other++; }
        else if (sevHigh) other++; // unrelated package (php, dotnet, ...): counted only
      }
      add("ok", name + " ALAS feed: " + recent.length + " bulletins in last " + DAYS + "d, " +
        hot + " critical/important for watched packages, " + other + " other critical/important (unwatched packages)");
    });
  }
}

function run(cmd, cmdArgs, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, cmdArgs, Object.assign({ cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, opts),
      (err, stdout, stderr) => {
        if (stdout) return resolve(stdout); // npm audit exits non-zero when it finds issues
        reject(err || new Error(stderr || "no output"));
      });
  });
}

async function checkNpm() {
  await source("npm audit", async () => {
    const out = JSON.parse(await run("npm", ["audit", "--omit=dev", "--json"]));
    const v = (out.metadata && out.metadata.vulnerabilities) || {};
    const msg = "npm audit (prod deps): critical " + (v.critical || 0) + ", high " + (v.high || 0) +
      ", moderate " + (v.moderate || 0) + ", low " + (v.low || 0);
    add(v.critical ? "action" : v.high ? "watch" : "ok", msg);
  });
}

async function checkDependabot() {
  await source("Dependabot alerts (gh)", async () => {
    const out = JSON.parse(await run("gh", ["api", "repos/{owner}/{repo}/dependabot/alerts?state=open&per_page=100"]));
    const count = (s) => out.filter((a) => a.security_advisory && a.security_advisory.severity === s).length;
    const crit = count("critical"), high = count("high");
    add(crit ? "action" : high ? "watch" : "ok",
      "Dependabot open alerts: critical " + crit + ", high " + high + " (of " + out.length + " open)");
  });
}

// ---- main -----------------------------------------------------------------

(async () => {
  readPins();
  await Promise.all([
    checkNode(), checkAlpine(), checkAmazonLinux(), checkRedis(),
    checkNginxAndOpenresty(), pandocNote(), checkAlas(),
    flag("--npm") ? checkNpm() : null,
    flag("--dependabot") ? checkDependabot() : null,
  ]);

  const result = {
    date: today.toISOString().slice(0, 10),
    pins,
    days: DAYS,
    actionNeeded: findings.action,
    watch: findings.watch,
    ok: findings.ok,
    unavailable: findings.unavailable,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const section = (title, list) => {
      console.log("\n" + title + (list.length ? "" : " (none)"));
      list.forEach((l) => console.log("  - " + l));
    };
    console.log("Security advisory check " + result.date + " (ALAS window " + DAYS + "d)");
    console.log("Pins: " + Object.entries(pins).map(([k, v]) => k + "=" + v).join(", "));
    section("ACTION NEEDED", findings.action);
    section("WATCH", findings.watch);
    section("SOURCES UNAVAILABLE", findings.unavailable);
    section("OK", findings.ok);
  }
  process.exit(findings.action.length ? 1 : 0);
})();
