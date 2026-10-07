// Daily check of the SSL certificates that OpenResty serves.
//
// Customer certificates are issued and renewed by lua-resty-auto-ssl, which
// stores each one in Redis as JSON at ssl:<domain>:latest and only logs
// renewal failures to OpenResty's error.log. Its renewal job starts at 30
// days left and runs daily, so a certificate under 25 days has had about five
// failed attempts. If renewal fails after the certificate has expired,
// auto-ssl deletes the key, so a missing key is only a problem for a domain
// we have seen with a certificate before (sslcheck:seen).
//
// The wildcard certificate for *.<host> is renewed by
// config/openresty/scripts/renew-wildcard-ssl.sh, which writes it to Redis.
//
// Run it without sending email:
//   NODE_PATH=app node app/scheduler/check-ssl-certificates.js
const crypto = require("crypto");
const tls = require("tls");
const config = require("config");
const clfdate = require("helper/clfdate");
const BackupDomain = require("models/blog/util/backupDomain");

const DAY = 24 * 60 * 60 * 1000;

const FAILING_DAYS = 25;
const URGENT_DAYS = 7;
const WILDCARD_WARNING_DAYS = 21;

// This many failing certificates at once suggests auto-ssl's renewal job
// itself is broken rather than individual domains.
const SYSTEMIC_COUNT = 10;

// Certificates are ~7KB each, so read them a batch at a time.
const BATCH_SIZE = 50;

const SEEN_KEY = "sslcheck:seen"; // domains observed with a certificate
const LAST_KEY = "sslcheck:last"; // hash of item key -> tier, last run

const WILDCARD_PEM_KEY = "blot:openresty:ssl:pem";
const WILDCARD_UPDATED_KEY = "blot:openresty:ssl:updated";

const HANDSHAKE_TIMEOUT_MS = 5000;

// Higher is worse. An item is re-sent when its rank goes up.
const RANK = { failing: 1, warning: 1, error: 1, urgent: 2, "expired-and-dropped": 3 };
const DAILY_TIERS = ["urgent", "expired-and-dropped"];

const formatDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysUntil = (ms, now) => Math.floor((ms - now) / DAY);

// MGET through sendCommand: Redis client-side caching is on for the app's
// client, and these 7KB values would push useful entries out of it.
async function mget(client, keys) {
  return client.sendCommand(["MGET", ...keys]);
}

// Never put the value in an error: it holds private keys.
function expiryOf(value) {
  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch (e) {
    throw new Error("malformed JSON");
  }

  const expiry = Number(parsed && parsed.expiry);

  // auto-ssl stores Unix seconds. Older certificates may not have it.
  if (expiry > 0) return expiry * 1000;

  try {
    return Date.parse(new crypto.X509Certificate(parsed.fullchain_pem).validTo);
  } catch (e) {
    throw new Error("no expiry, and fullchain_pem could not be parsed");
  }
}

function tierFor(daysLeft) {
  if (daysLeft < URGENT_DAYS) return "urgent";
  if (daysLeft < FAILING_DAYS) return "failing";
  return null;
}

async function defaultListBlogs() {
  const Blog = require("models/blog");
  const { promisify } = require("util");
  const getAllIDs = promisify(Blog.getAllIDs);
  const get = promisify(Blog.get);
  const blogs = [];

  for (const id of await getAllIDs()) {
    const blog = await get({ id });
    if (blog) {
      blogs.push({
        id,
        handle: blog.handle,
        domain: blog.domain,
        isDisabled: blog.isDisabled,
      });
    }
  }

  return blogs;
}

function defaultCheckServedCert(host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port: 443,
      servername: host,
      rejectUnauthorized: false, // an expired certificate is what we're after
      timeout: HANDSHAKE_TIMEOUT_MS,
    });

    socket.once("secureConnect", () => {
      const validTo = Date.parse(socket.getPeerCertificate().valid_to);
      socket.destroy();
      resolve({ validTo });
    });
    socket.once("timeout", () => socket.destroy(new Error("handshake timed out")));
    socket.once("error", reject);
  });
}

// Customer domains with a certificate that needs attention, in the tiers
// described at the top. Returns { items, ignored, errors, observed, stale }.
async function checkCustomerCerts({ now, client, listBlogs, verifyDNS }) {
  const seen = new Set(await client.sMembers(SEEN_KEY));
  const host = config.host;
  const owners = new Map(); // domain -> blog

  for (const blog of await listBlogs()) {
    if (blog.isDisabled || !blog.domain) continue;

    for (const domain of [blog.domain, BackupDomain(blog.domain)]) {
      // Subdomains of Blot use the wildcard certificate
      if (domain === host || domain.endsWith("." + host)) continue;
      if (!owners.has(domain)) owners.set(domain, blog);
    }
  }

  // auto-ssl only renews domains with a domain:<d> key, which is also what
  // excludes the BackupDomain twin of a blog that doesn't answer on it
  const candidates = Array.from(owners.keys());
  const domains = [];

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const found = await mget(client, batch.map((d) => "domain:" + d));
    batch.forEach((domain, j) => found[j] && domains.push(domain));
  }

  const troubled = [];
  const errors = [];
  const observed = [];

  for (let i = 0; i < domains.length; i += BATCH_SIZE) {
    const batch = domains.slice(i, i + BATCH_SIZE);
    const values = await mget(client, batch.map((d) => `ssl:${d}:latest`));

    batch.forEach((domain, j) => {
      const blog = owners.get(domain);

      if (!values[j]) {
        if (seen.has(domain)) {
          troubled.push({ domain, blog, tier: "expired-and-dropped", daysLeft: null, expires: null });
        }
        return;
      }

      observed.push(domain);

      try {
        const expires = expiryOf(values[j]);
        const daysLeft = daysUntil(expires, now);
        const tier = tierFor(daysLeft);
        if (tier) troubled.push({ domain, blog, tier, daysLeft, expires });
      } catch (err) {
        errors.push({ domain, handle: blog.handle, message: err.message });
      }
    });
  }

  const items = [];
  const ignored = [];

  for (const cert of troubled) {
    let dns = { status: "unknown" };

    try {
      dns = await verifyDNS(cert.domain, cert.blog);
    } catch (err) {
      console.log(clfdate(), "SSL check: DNS check failed for", cert.domain, err.message);
    }

    const item = {
      key: "cert:" + cert.domain,
      kind: "cert",
      domain: cert.domain,
      handle: cert.blog.handle,
      tier: cert.tier,
      daysLeft: cert.daysLeft,
      expires: cert.expires,
      proxied: dns.status === "proxied",
      extraIPs: dns.status === "mixed" ? dns.extraIPs : [],
    };

    if (dns.status === "moved") {
      console.log(clfdate(), "SSL check: ignoring", cert.domain, "(DNS no longer points at Blot)", cert.tier, cert.daysLeft);
      ignored.push(item);
    } else {
      items.push(item);
    }
  }

  // Domains that left every blog needn't stay in the seen set
  const stale = Array.from(seen).filter((d) => !owners.has(d));

  return { items, ignored, errors, observed, stale };
}

// The certificate in Redis, and the one OpenResty is actually serving
async function checkWildcard({ now, client, checkServedCert }) {
  const items = [];
  const pem = await client.get(WILDCARD_PEM_KEY);
  const updated = Number(await client.get(WILDCARD_UPDATED_KEY)) * 1000 || null;
  const updatedNote = updated ? ` Last renewal run: ${formatDate(updated)}.` : " No record of a renewal run.";
  let expires = null;

  const add = (key, tier, message) =>
    items.push({ key, kind: "wildcard", tier, message: message + updatedNote });

  if (!pem) {
    add("wildcard", "urgent", `Certificate is missing from Redis (${WILDCARD_PEM_KEY}).`);
  } else {
    try {
      // The first certificate in the PEM is the leaf
      expires = Date.parse(new crypto.X509Certificate(pem).validTo);
    } catch (e) {
      add("wildcard", "urgent", `Certificate in Redis (${WILDCARD_PEM_KEY}) could not be parsed.`);
    }
  }

  if (expires) {
    const daysLeft = daysUntil(expires, now);
    const tier = daysLeft < URGENT_DAYS ? "urgent" : daysLeft < WILDCARD_WARNING_DAYS ? "warning" : null;
    if (tier) add("wildcard", tier, `Certificate in Redis expires ${formatDate(expires)} (${daysLeft} days left).`);
  }

  try {
    const { validTo } = await checkServedCert(config.host);
    const daysLeft = daysUntil(validTo, now);
    const sooner = expires ? validTo < expires - DAY : daysLeft < WILDCARD_WARNING_DAYS;

    if (sooner) {
      add(
        "wildcard-served",
        daysLeft < URGENT_DAYS ? "urgent" : "warning",
        `OpenResty is serving a certificate that expires ${formatDate(validTo)} (${daysLeft} days left)` +
          (expires ? `, but Redis has one expiring ${formatDate(expires)}: renewed but OpenResty not reloaded?` : ".")
      );
    }
  } catch (err) {
    console.log(clfdate(), "SSL check: could not read the served certificate for", config.host, err.message);
  }

  return { items, expires, updated };
}

// Resolves to the report:
//   { now, items, ignored, errors, observed, stale, systemic, wildcard }
// items are certificates and wildcard problems, worst first.
async function check(deps = {}) {
  const {
    now = Date.now(),
    client = require("models/client"),
    listBlogs = defaultListBlogs,
    verifyDNS = require("./check-ssl-certificates-dns"),
    checkServedCert = defaultCheckServedCert,
  } = deps;

  const customers = await checkCustomerCerts({ now, client, listBlogs, verifyDNS });
  const wildcard = await checkWildcard({ now, client, checkServedCert });

  // Dropped certificates (no daysLeft) are the most overdue, so they go first
  const certs = customers.items.sort(
    (a, b) => (a.daysLeft ?? -Infinity) < (b.daysLeft ?? -Infinity) ? -1 : 1
  );
  const items = [...wildcard.items, ...certs];

  const failing = customers.items.filter((item) => item.tier === "failing" || item.tier === "urgent");

  return {
    now,
    items,
    ignored: customers.ignored,
    errors: customers.errors,
    observed: customers.observed,
    stale: customers.stale,
    systemic: failing.length >= SYSTEMIC_COUNT ? failing.length : 0,
    wildcard: { expires: wildcard.expires, updated: wildcard.updated },
  };
}

// What the email template renders. newKeys are the items to flag as new.
function view(report, newKeys) {
  const isNew = (key) => newKeys.has(key);
  const lines = (list) => list.map((item) => ({ ...item, isNew: isNew(item.key) }));

  const detailFor = (item) => {
    if (item.tier === "expired-and-dropped") {
      return "**expired and dropped**: no certificate in Redis, which auto-ssl does when it fails to renew one after it expires";
    }

    let text = `**${item.tier}**: ${item.daysLeft} days left, expires ${formatDate(item.expires)}`;

    if (item.extraIPs.length) {
      text += `. Extra A record(s) ${item.extraIPs.join(", ")} not pointing at Blot, likely why renewal fails`;
    }

    return text;
  };

  const certs = report.items.filter((item) => item.kind === "cert").map((item) => ({ ...item, detail: detailFor(item) }));
  const wildcard = report.items.filter((item) => item.kind === "wildcard");
  const errors = report.errors.map((e) => ({ ...e, key: "error:" + e.domain }));

  const all = [...report.items, ...errors];
  const urgent = all.filter((item) => DAILY_TIERS.includes(item.tier)).length;
  const summary = [urgent && `${urgent} urgent`, all.length - urgent && `${all.length - urgent} to watch`]
    .filter(Boolean)
    .join(", ");

  return {
    summary,
    host: config.host,
    hasSystemic: report.systemic > 0,
    systemicCount: report.systemic,
    hasWildcard: wildcard.length > 0,
    wildcard: lines(wildcard),
    hasCerts: certs.some((c) => !c.proxied),
    certs: lines(certs.filter((c) => !c.proxied)),
    hasProxied: certs.some((c) => c.proxied),
    proxied: lines(certs.filter((c) => c.proxied)),
    hasErrors: errors.length > 0,
    errors: lines(errors),
    hasIgnored: report.ignored.length > 0,
    ignoredCount: report.ignored.length,
  };
}

// Runs the check and emails when something is new or has got worse since the
// last run, or every day while anything is urgent. deps.sendEmail(view) must
// reject if the email fails, so that the same items are reported next time.
async function run(deps = {}) {
  const client = deps.client || require("models/client");
  const sendEmail = deps.sendEmail || (async () => {});
  const report = await check({ ...deps, client });

  const previous = await client.hGetAll(LAST_KEY);
  const current = {};
  const newKeys = new Set();

  const entries = [
    ...report.items,
    ...report.errors.map((e) => ({ key: "error:" + e.domain, tier: "error" })),
  ];

  for (const { key, tier } of entries) {
    current[key] = tier;
    if (!(key in previous) || RANK[tier] > (RANK[previous[key]] || 0)) newKeys.add(key);
  }

  // Never-seen domains stay out of "expired and dropped", so remember who has
  // had a certificate. Done even if the email fails.
  if (report.observed.length) await client.sAdd(SEEN_KEY, report.observed);
  if (report.stale.length) await client.sRem(SEEN_KEY, report.stale);

  const urgent = entries.some((entry) => DAILY_TIERS.includes(entry.tier));
  const send = newKeys.size > 0 || urgent;

  if (send) await sendEmail(view(report, newKeys));

  await client.del(LAST_KEY);
  if (entries.length) await client.hSet(LAST_KEY, current);

  return { report, sent: send };
}

module.exports = run;
module.exports.check = check;
module.exports.view = view;

if (require.main === module) {
  check()
    .then((report) => {
      const { observed, stale, ...rest } = report;
      console.log(JSON.stringify({ ...rest, now: new Date(report.now) }, null, 2));
      process.exit();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
