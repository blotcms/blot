// Early warning for SSL certificates that are not renewing, from Redis alone.
//
// lua-resty-auto-ssl keeps each customer certificate in Redis as JSON at
// ssl:<domain>:latest and starts renewing at 30 days left, trying daily. It
// only logs failures, so a certificate under 25 days has had about five failed
// attempts. We warn long before the certificate expires and auto-ssl deletes it.
//
// The wildcard certificate for *.<host> is renewed by
// config/openresty/scripts/renew-wildcard-ssl.sh, which writes it to Redis.
//
// Print the report without sending email:
//   NODE_PATH=app node app/scheduler/check-ssl-certificates.js
const crypto = require("crypto");
const config = require("config");

const DAY = 24 * 60 * 60 * 1000;

const FLAGGED_DAYS = 25;
const URGENT_DAYS = 7;
const WILDCARD_WARNING_DAYS = 21;

// About 19 certificates a day cross the 30 day renewal point, and a handful
// are always flagged for reasons that are the customer's (a few have extra
// A records), so 20 flagged means renewal has stopped altogether. That is
// reached about a day after the five day grace period, whereas a broken
// domain or two never gets near it.
const SYSTEMIC_COUNT = 20;

// Certificates are ~7KB each, so read them a batch at a time.
const BATCH_SIZE = 50;

// Urgent domains we have already emailed about, so each is mentioned once
const NOTIFIED_KEY = "sslcheck:notified";

const WILDCARD_PEM_KEY = "blot:openresty:ssl:pem";
const WILDCARD_UPDATED_KEY = "blot:openresty:ssl:updated";

const formatDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysUntil = (ms, now) => Math.floor((ms - now) / DAY);

// MGET through sendCommand: Redis client-side caching is on for the app's
// client, and these 7KB values would push useful entries out of it.
const mget = (client, keys) => client.sendCommand(["MGET", ...keys]);

async function scanCertKeys(client) {
  const keys = new Set(); // SCAN can return a key more than once
  let cursor = "0";

  do {
    const reply = await client.scan(cursor, { MATCH: "ssl:*:latest", COUNT: 1000 });
    cursor = String(reply.cursor);
    reply.keys.forEach((key) => keys.add(key));
  } while (cursor !== "0");

  return Array.from(keys);
}

// Never put the value in an error: it holds a private key.
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

async function checkCustomerCerts({ now, client, getBlog }) {
  const keys = await scanCertKeys(client);
  const flagged = [];
  const errors = [];

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    const values = await mget(client, batch);

    batch.forEach((key, j) => {
      const domain = key.slice("ssl:".length, -":latest".length);

      // Subdomains of Blot use the wildcard certificate
      if (!values[j] || domain.endsWith("." + config.host)) return;

      try {
        const expires = expiryOf(values[j]);
        const daysLeft = daysUntil(expires, now);
        if (daysLeft < FLAGGED_DAYS) flagged.push({ domain, daysLeft, expires });
      } catch (err) {
        errors.push({ domain, message: err.message });
      }
    });
  }

  // auto-ssl only renews domains with a domain:<d> key, so a certificate
  // without one is expected to age out
  const certs = [];
  let flaggedCount = 0;

  for (const cert of flagged) {
    const blogID = await client.get("domain:" + cert.domain);
    if (!blogID) continue;

    flaggedCount++;

    const blog = await getBlog({ id: blogID });
    if (!blog || blog.isDisabled) continue;

    certs.push({
      ...cert,
      handle: blog.handle,
      urgent: cert.daysLeft < URGENT_DAYS,
    });
  }

  certs.sort((a, b) => a.daysLeft - b.daysLeft);

  return { certs, errors, flaggedCount, scanned: keys.length };
}

async function checkWildcard({ now, client }) {
  const pem = await client.get(WILDCARD_PEM_KEY);
  const updated = Number(await client.get(WILDCARD_UPDATED_KEY)) * 1000 || null;
  const wildcard = { problem: true, urgent: true, updated, expires: null, daysLeft: null };

  if (!pem) {
    return { ...wildcard, message: `missing from Redis (${WILDCARD_PEM_KEY})` };
  }

  try {
    // The first certificate in the PEM is the leaf
    wildcard.expires = Date.parse(new crypto.X509Certificate(pem).validTo);
  } catch (e) {
    return { ...wildcard, message: `could not be parsed (${WILDCARD_PEM_KEY})` };
  }

  wildcard.daysLeft = daysUntil(wildcard.expires, now);
  wildcard.urgent = wildcard.daysLeft < URGENT_DAYS;
  wildcard.problem = wildcard.daysLeft < WILDCARD_WARNING_DAYS;
  wildcard.message = `${wildcard.daysLeft} days left, expires ${formatDate(wildcard.expires)}`;

  return wildcard;
}

// Resolves to { now, certs, errors, flaggedCount, scanned, systemic, wildcard }.
// certs are the flagged customer certificates with a domain key and an enabled
// blog, fewest days left first.
async function check(deps = {}) {
  const {
    now = Date.now(),
    client = require("models/client"),
    getBlog = require("util").promisify(require("models/blog").get),
  } = deps;

  const customers = await checkCustomerCerts({ now, client, getBlog });
  const wildcard = await checkWildcard({ now, client });

  return {
    now,
    ...customers,
    systemic: customers.flaggedCount >= SYSTEMIC_COUNT,
    wildcard,
  };
}

// What the email template renders
function view(report) {
  const urgent = report.certs.filter((cert) => cert.urgent);
  const format = (cert) => ({ ...cert, date: formatDate(cert.expires) });
  const { wildcard } = report;

  const summary = [
    report.systemic && "renewal looks broken",
    wildcard.problem && "wildcard certificate",
    urgent.length && `${urgent.length} urgent`,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    summary,
    host: config.host,
    hasSystemic: report.systemic,
    flaggedCount: report.flaggedCount,
    wildcard: {
      ...wildcard,
      updatedDate: wildcard.updated ? formatDate(wildcard.updated) : "never",
    },
    hasUrgent: urgent.length > 0,
    urgent: urgent.map(format),
    hasOther: urgent.length < report.certs.length,
    other: report.certs.filter((cert) => !cert.urgent).map(format),
    errorCount: report.errors.length,
  };
}

// Runs the check and emails if renewal looks broken, the wildcard certificate
// needs attention, or a customer certificate has become urgent since the last
// email. Certificates that are merely flagged are listed but never email on
// their own. deps.sendEmail(view) must reject on failure so the same domains
// are reported again next time.
async function run(deps = {}) {
  const client = deps.client || require("models/client");
  const sendEmail = deps.sendEmail || (async () => {});
  const report = await check({ ...deps, client });

  const urgent = report.certs.filter((cert) => cert.urgent).map((cert) => cert.domain);
  const notified = new Set(await client.sMembers(NOTIFIED_KEY));
  const fresh = urgent.filter((domain) => !notified.has(domain));
  const send = report.systemic || report.wildcard.problem || fresh.length > 0;

  if (send) await sendEmail(view(report));

  // Once no longer urgent, a domain is reported again if it recurs
  const cleared = Array.from(notified).filter((domain) => !urgent.includes(domain));
  if (cleared.length) await client.sRem(NOTIFIED_KEY, cleared);
  if (send && urgent.length) await client.sAdd(NOTIFIED_KEY, urgent);

  return { report, sent: send };
}

module.exports = run;
module.exports.check = check;
module.exports.view = view;

if (require.main === module) {
  check()
    .then((report) => {
      console.log(JSON.stringify({ ...report, now: new Date(report.now) }, null, 2));
      process.exit();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
