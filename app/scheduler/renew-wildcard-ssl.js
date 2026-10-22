// Renews the wildcard certificate for BLOT_HOST and *.BLOT_HOST (DNS-01 via
// Route 53) and stores it in Redis, where the proxy reads it:
//
//   blot:openresty:ssl:key      private key, PEM
//   blot:openresty:ssl:pem      leaf certificate followed by its chain, PEM
//   blot:openresty:ssl:updated  Unix seconds of the last write
//
// It renews only when the certificate in Redis is missing, unreadable, lacks
// a matching key, or has less than RENEW_DAYS left, so running it daily is cheap. Failures throw: the
// scheduler logs them, and app/scheduler/check-ssl-certificates.js emails the
// admin if the certificate gets under 21 days, about nine daily attempts in.
//
// Both names are validated at _acme-challenge.<host>, so the TXT record set
// must hold both values at once. The record is removed afterwards, even when
// issuing fails.
//
// Force a run (renews regardless of expiry), from an app container:
//   NODE_PATH=app node app/scheduler/renew-wildcard-ssl.js --force
const crypto = require("crypto");
const config = require("config");

const DAY = 24 * 60 * 60 * 1000;
const RENEW_DAYS = 30;

const PEM_KEY = "blot:openresty:ssl:pem";
const KEY_KEY = "blot:openresty:ssl:key";
const UPDATED_KEY = "blot:openresty:ssl:updated";
const ACCOUNT_KEY = "blot:openresty:ssl:account-key";

const TXT_TTL = 60;
const IN_SYNC_POLL_MS = 5000;
const IN_SYNC_TIMEOUT_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The TXT record Route 53 changes go through. Route 53 is global, so its API
// lives in us-east-1. deps: sdk and client (injected in tests), zoneId, sleep.
function route53Dns(deps = {}) {
  const sdk = deps.sdk || require("@aws-sdk/client-route-53");
  const zoneId = deps.zoneId;
  const wait = deps.sleep || sleep;
  let client = deps.client;

  if (!client) {
    const options = { region: "us-east-1" };

    if (config.aws.key && config.aws.secret) {
      options.credentials = {
        accessKeyId: config.aws.key,
        secretAccessKey: config.aws.secret,
      };
    }

    client = new sdk.Route53Client(options);
  }

  const change = (action, name, values) =>
    client.send(
      new sdk.ChangeResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        ChangeBatch: {
          Changes: [
            {
              Action: action,
              ResourceRecordSet: {
                Name: name,
                Type: "TXT",
                TTL: TXT_TTL,
                ResourceRecords: values.map((value) => ({ Value: `"${value}"` })),
              },
            },
          ],
        },
      })
    );

  async function waitInSync(id) {
    const deadline = Date.now() + IN_SYNC_TIMEOUT_MS;

    for (;;) {
      const { ChangeInfo } = await client.send(new sdk.GetChangeCommand({ Id: id }));

      if (ChangeInfo.Status === "INSYNC") return;
      if (Date.now() > deadline) {
        throw new Error("Route 53 change " + id + " was not INSYNC after 5 minutes");
      }

      await wait(IN_SYNC_POLL_MS);
    }
  }

  return {
    // Sets the record's values and resolves once Route 53 has propagated them
    async set(name, values) {
      const { ChangeInfo } = await change("UPSERT", name, values);
      await waitInSync(ChangeInfo.Id);
    },
    // Deletes need the record exactly as it was set
    async remove(name, values) {
      await change("DELETE", name, values);
    },
  };
}

// Days until the leaf certificate in a PEM expires, or null if unreadable
function daysLeft(pem, now) {
  try {
    return Math.floor((Date.parse(new crypto.X509Certificate(pem).validTo) - now) / DAY);
  } catch (e) {
    return null;
  }
}

// Days left on the certificate in Redis, or null if it is missing or
// unreadable, or the key beside it is missing or does not match it: the proxy
// needs both, and without them serves the file, which goes stale.
function usableDaysLeft(pem, key, now) {
  const days = daysLeft(pem, now);
  if (days === null) return null;

  try {
    const cert = new crypto.X509Certificate(pem);
    return cert.checkPrivateKey(crypto.createPrivateKey(key)) ? days : null;
  } catch (e) {
    return null;
  }
}

// One ACME account per Blot, kept in Redis so Let's Encrypt sees the same one
// each time. SET NX so two racing processes still agree on a key.
async function accountKey({ client, acme }) {
  const existing = await client.get(ACCOUNT_KEY);
  if (existing) return existing;

  const created = (await acme.crypto.createPrivateKey()).toString();
  await client.set(ACCOUNT_KEY, created, { NX: true });

  return (await client.get(ACCOUNT_KEY)) || created;
}

// Orders the certificate. Returns { key, pem }. Both names share one
// challenge record, so all pending values are published before any challenge
// is completed.
async function issue({ acme, acmeClient, dns, host }) {
  const names = ["*." + host, host];
  const recordName = "_acme-challenge." + host;

  const order = await acmeClient.createOrder({
    identifiers: names.map((value) => ({ type: "dns", value })),
  });
  const authorizations = await acmeClient.getAuthorizations(order);

  const pending = [];

  for (const authorization of authorizations) {
    if (authorization.status === "valid") continue;

    const challenge = authorization.challenges.find((c) => c.type === "dns-01");
    if (!challenge) {
      throw new Error("No dns-01 challenge offered for " + authorization.identifier.value);
    }

    pending.push({
      challenge,
      value: await acmeClient.getChallengeKeyAuthorization(challenge),
    });
  }

  const values = [...new Set(pending.map((p) => p.value))];

  try {
    if (values.length) {
      await dns.set(recordName, values);

      for (const { challenge } of pending) {
        await acmeClient.completeChallenge(challenge);
      }

      for (const { challenge } of pending) {
        await acmeClient.waitForValidStatus(challenge);
      }
    }

    // ECDSA P-256: the handshake carries a much smaller certificate than RSA
    const certificateKey = await acme.crypto.createPrivateEcdsaKey();
    const [key, csr] = await acme.crypto.createCsr(
      {
        commonName: host,
        altNames: names,
      },
      certificateKey
    );
    const finalized = await acmeClient.finalizeOrder(order, csr);
    const pem = await acmeClient.getCertificate(finalized);

    return { key: key.toString(), pem };
  } finally {
    if (values.length) {
      try {
        await dns.remove(recordName, values);
      } catch (err) {
        console.error("Wildcard SSL: could not remove " + recordName + " TXT record", err);
      }
    }
  }
}

const withNewline = (text) => (text.endsWith("\n") ? text : text + "\n");

// Resolves to { renewed: false, daysLeft } when the certificate in Redis is
// fine, or { renewed: true, daysLeft } (days left on the new certificate).
// deps: client (Redis), acme, acmeClient, dns, host, now, force. Throws if
// renewal fails.
async function renew(deps = {}) {
  const {
    client = require("models/client"),
    host = config.host,
    now = Date.now(),
    force = false,
  } = deps;

  const current = usableDaysLeft(await client.get(PEM_KEY), await client.get(KEY_KEY), now);

  if (!force && current !== null && current > RENEW_DAYS) {
    return { renewed: false, daysLeft: current };
  }

  const zoneId = config.wildcardSSL.hostedZoneId;

  if (!host) throw new Error("BLOT_HOST is not set");
  if (!deps.dns && !zoneId) throw new Error("BLOT_WILDCARD_SSL_HOSTED_ZONE_ID is not set");

  const dns = deps.dns || route53Dns({ zoneId });

  console.log(
    "Wildcard SSL: renewing certificate for " + host + " and *." + host + " (" +
      (current === null ? "no usable certificate and key in Redis" : current + " days left") + ")"
  );

  const acme = deps.acme || require("acme-client");
  const acmeClient =
    deps.acmeClient ||
    new acme.Client({
      directoryUrl: config.wildcardSSL.directoryUrl,
      accountKey: await accountKey({ client, acme }),
    });

  const contact = config.admin.email ? ["mailto:" + config.admin.email] : undefined;
  await acmeClient.createAccount({ termsOfServiceAgreed: true, contact });

  const { key, pem } = await issue({ acme, acmeClient, dns, host });

  // Never store something the proxy could not serve
  let x509;
  try {
    x509 = new crypto.X509Certificate(pem);
  } catch (e) {
    throw new Error("Let's Encrypt returned a certificate which could not be parsed");
  }
  if (!x509.checkHost(host) || !x509.checkHost("example." + host)) {
    throw new Error("The issued certificate does not cover " + host + " and *." + host);
  }

  await client
    .multi()
    .set(KEY_KEY, withNewline(key))
    .set(PEM_KEY, withNewline(pem))
    .set(UPDATED_KEY, String(Math.floor(now / 1000)))
    .exec();

  const issued = daysLeft(pem, now);
  console.log("Wildcard SSL: stored new certificate in Redis, " + issued + " days left");

  return { renewed: true, daysLeft: issued };
}

module.exports = renew;
module.exports.route53Dns = route53Dns;
module.exports.RENEW_DAYS = RENEW_DAYS;
module.exports.ACCOUNT_KEY = ACCOUNT_KEY;

if (require.main === module) {
  renew({ force: process.argv.includes("--force") })
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
