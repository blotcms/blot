describe("scheduler check-ssl-certificates", function () {
  const crypto = require("crypto");
  const config = require("config");
  const run = require("../check-ssl-certificates");
  const check = run.check;

  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 9, 7, 12);

  // A real (public) self-signed certificate, valid until 2126, with no
  // private key. Used where the check has to parse a PEM.
  const PEM = [
    "-----BEGIN CERTIFICATE-----",
    "MIIBhTCCASugAwIBAgIUV67+QZQoYJLMiqBdC2Wu06UuBy4wCgYIKoZIzj0EAwIw",
    "FzEVMBMGA1UEAwwMdGVzdC5leGFtcGxlMCAXDTI2MTAwNzE0MzUwMloYDzIxMjYw",
    "OTEzMTQzNTAyWjAXMRUwEwYDVQQDDAx0ZXN0LmV4YW1wbGUwWTATBgcqhkjOPQIB",
    "BggqhkjOPQMBBwNCAATwSjTSaat71AT/an2EmCHtGVnf9GtndD8qDbuxShCpsFwT",
    "OWlEyhSkduxwtp4V1qFidyJtJAYieEejo+V99T5Lo1MwUTAdBgNVHQ4EFgQUqz3p",
    "DN9fPT7ePG+AgULHAvuNB2YwHwYDVR0jBBgwFoAUqz3pDN9fPT7ePG+AgULHAvuN",
    "B2YwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA76FQ+1mUrOMX",
    "O2XmFTvIxpkQV1dgrLQtiVtXLzsAP6MCIAZf8ulx4MJuxRGWM7cDJ3QpOjkMOyi3",
    "lxVBiLUdYoed",
    "-----END CERTIFICATE-----",
    "",
  ].join("\n");

  const PEM_EXPIRES = Date.parse(new crypto.X509Certificate(PEM).validTo);

  const SECRET = "PRIVATE-KEY-MATERIAL";

  const certJSON = (daysLeft) =>
    JSON.stringify({
      fullchain_pem: "chain",
      privkey_pem: SECRET,
      cert_pem: "cert",
      expiry: Math.floor((NOW + daysLeft * DAY) / 1000),
    });

  // The parts of the Redis client the job uses. scan returns the keys in
  // two pages, repeating the first key in the second.
  function fakeRedis(strings) {
    const store = new Map(Object.entries(strings));
    const sets = new Map();
    const set = (key) => sets.get(key) || sets.set(key, new Set()).get(key);

    return {
      store,
      set,
      get: async (key) => (store.has(key) ? store.get(key) : null),
      sendCommand: async ([command, ...keys]) => {
        expect(command).toEqual("MGET");
        return keys.map((key) => (store.has(key) ? store.get(key) : null));
      },
      scan: async (cursor, options) => {
        expect(options).toEqual({ MATCH: "ssl:*:latest", COUNT: 1000 });
        const keys = Array.from(store.keys()).filter((k) => /^ssl:.*:latest$/.test(k));
        if (cursor === "0") return { cursor: "1", keys: keys.slice(0, 1) };
        return { cursor: "0", keys };
      },
      sMembers: async (key) => Array.from(set(key)),
      sAdd: async (key, members) => members.forEach((m) => set(key).add(m)),
      sRem: async (key, members) => members.forEach((m) => set(key).delete(m)),
    };
  }

  // Redis with a healthy wildcard, the given certificates ({domain: json}),
  // and a domain: key and blog for each unless it is in `noKey`
  function setup({ certs = {}, noKey = [], disabled = [] }) {
    const strings = {
      "blot:openresty:ssl:pem": PEM,
      "blot:openresty:ssl:updated": String(Math.floor(NOW / 1000)),
    };

    for (const [domain, value] of Object.entries(certs)) {
      strings[`ssl:${domain}:latest`] = value;
      if (!noKey.includes(domain)) strings["domain:" + domain] = "blog_" + domain;
    }

    const sent = [];

    return {
      now: PEM_EXPIRES - 84 * DAY,
      client: fakeRedis(strings),
      getBlog: async ({ id }) => ({
        id,
        handle: id.slice("blog_".length).split(".")[0],
        isDisabled: disabled.includes(id.slice("blog_".length)),
      }),
      sent,
      sendEmail: async (view) => {
        sent.push(view);
      },
    };
  }

  const withNow = (deps) => ({ ...deps, now: NOW });

  const domains = (report) => report.certs.map((cert) => cert.domain);

  // Certificates for count domains, each with the given days left
  function many(count, daysLeft) {
    const certs = {};
    for (let i = 0; i < count; i++) certs[`b${i}.com`] = certJSON(daysLeft);
    return certs;
  }

  describe("customer certificates", function () {
    it("ignores a healthy certificate", async function () {
      const deps = withNow(setup({ certs: { "a.com": certJSON(25) } }));

      const report = await check(deps);

      expect(report.certs).toEqual([]);
      expect(report.errors).toEqual([]);
      expect(report.scanned).toEqual(1);
    });

    it("ignores a flagged certificate without a domain key", async function () {
      const deps = withNow(
        setup({ certs: { "a.com": certJSON(10) }, noKey: ["a.com"] })
      );

      const report = await check(deps);

      expect(report.certs).toEqual([]);
      expect(report.flaggedCount).toEqual(0);
    });

    it("lists a flagged certificate with a domain key", async function () {
      const deps = withNow(setup({ certs: { "a.com": certJSON(24) } }));

      const report = await check(deps);

      expect(report.certs).toEqual([
        {
          domain: "a.com",
          handle: "a",
          daysLeft: 24,
          expires: NOW + 24 * DAY,
          urgent: false,
        },
      ]);
    });

    it("marks a certificate under 7 days urgent, sorted by days left", async function () {
      const deps = withNow(
        setup({
          certs: { "a.com": certJSON(20), "b.com": certJSON(6), "c.com": certJSON(7) },
        })
      );

      const report = await check(deps);

      expect(report.certs.map((c) => [c.domain, c.urgent])).toEqual([
        ["b.com", true],
        ["c.com", false],
        ["a.com", false],
      ]);
    });

    it("skips a disabled blog, or one that no longer exists", async function () {
      const deps = withNow(
        setup({
          certs: { "a.com": certJSON(3), "b.com": certJSON(3), "c.com": certJSON(3) },
          disabled: ["a.com"],
        })
      );
      const getBlog = deps.getBlog;
      deps.getBlog = async (by) => (by.id === "blog_b.com" ? null : getBlog(by));

      expect(domains(await check(deps))).toEqual(["c.com"]);
    });

    it("skips subdomains of the host", async function () {
      const domain = "someone." + config.host;
      const deps = withNow(setup({ certs: { [domain]: certJSON(3) } }));

      expect((await check(deps)).certs).toEqual([]);
    });

    it("falls back to the X509 expiry when the entry has none", async function () {
      const deps = setup({
        certs: { "a.com": JSON.stringify({ fullchain_pem: PEM }) },
      });
      deps.now = PEM_EXPIRES - 10 * DAY;

      const report = await check(deps);

      expect(report.certs.length).toEqual(1);
      expect(report.certs[0].daysLeft).toEqual(10);
      expect(report.certs[0].expires).toEqual(PEM_EXPIRES);
    });

    it("records malformed entries as errors without leaking them", async function () {
      const deps = withNow(
        setup({
          certs: {
            "a.com": `{"privkey_pem":"${SECRET}" nope`,
            "b.com": JSON.stringify({ privkey_pem: SECRET }),
            "c.com": certJSON(5),
          },
        })
      );

      const report = await check(deps);

      expect(domains(report)).toEqual(["c.com"]);
      expect(report.errors.map((e) => e.domain)).toEqual(["a.com", "b.com"]);
      expect(JSON.stringify(report)).not.toContain(SECRET);
    });

    it("reads a certificate once when SCAN repeats its key", async function () {
      const deps = withNow(setup({ certs: { "a.com": certJSON(10) } }));

      const report = await check(deps);

      expect(report.scanned).toEqual(1);
      expect(report.certs.length).toEqual(1);
    });

    it("flags a systemic failure at 20 flagged certificates", async function () {
      expect((await check(withNow(setup({ certs: many(19, 20) })))).systemic).toEqual(false);
      expect((await check(withNow(setup({ certs: many(20, 20) })))).systemic).toEqual(true);
    });

    it("counts flagged certificates of disabled blogs towards a systemic failure", async function () {
      const certs = many(20, 20);
      const deps = withNow(setup({ certs, disabled: Object.keys(certs) }));

      const report = await check(deps);

      expect(report.certs).toEqual([]);
      expect(report.systemic).toEqual(true);
    });
  });

  describe("wildcard certificate", function () {
    it("is fine with plenty of time left", async function () {
      const { wildcard } = await check(setup({}));

      expect(wildcard.problem).toEqual(false);
      expect(wildcard.daysLeft).toEqual(84);
    });

    it("is missing", async function () {
      const deps = setup({});
      deps.client.store.delete("blot:openresty:ssl:pem");

      const { wildcard } = await check(deps);

      expect(wildcard.problem).toEqual(true);
      expect(wildcard.urgent).toEqual(true);
      expect(wildcard.message).toContain("missing");
    });

    it("can't be parsed", async function () {
      const deps = setup({});
      deps.client.store.set("blot:openresty:ssl:pem", "not a certificate");

      const { wildcard } = await check(deps);

      expect(wildcard.urgent).toEqual(true);
      expect(wildcard.message).toContain("could not be parsed");
    });

    it("warns under 21 days and is urgent under 7", async function () {
      const deps = setup({});

      deps.now = PEM_EXPIRES - 21 * DAY;
      expect((await check(deps)).wildcard.problem).toEqual(false);

      deps.now = PEM_EXPIRES - 20 * DAY;
      let { wildcard } = await check(deps);
      expect([wildcard.problem, wildcard.urgent]).toEqual([true, false]);

      deps.now = PEM_EXPIRES - 6 * DAY;
      wildcard = (await check(deps)).wildcard;
      expect([wildcard.problem, wildcard.urgent]).toEqual([true, true]);
    });

    it("reports the last renewal date and never reads the key", async function () {
      const deps = setup({});
      const get = deps.client.get;
      const read = [];
      deps.client.get = async (key) => {
        read.push(key);
        return get(key);
      };
      deps.client.store.set(
        "blot:openresty:ssl:updated",
        String(Date.UTC(2026, 9, 1, 9) / 1000)
      );

      const report = await check(deps);

      expect(run.view(report).wildcard.updatedDate).toEqual("2026-10-01");
      expect(read).not.toContain("blot:openresty:ssl:key");
    });
  });

  describe("emailing", function () {
    it("sends nothing for healthy certificates", async function () {
      const deps = withNow(setup({ certs: { "a.com": certJSON(60) } }));

      expect((await run(deps)).sent).toEqual(false);
      expect(deps.sent).toEqual([]);
    });

    it("lists flagged certificates but does not email for them alone", async function () {
      const deps = withNow(setup({ certs: { "a.com": certJSON(10) } }));

      await run(deps);

      expect(deps.sent).toEqual([]);
    });

    it("emails for an urgent certificate, listing the flagged ones too", async function () {
      const deps = withNow(
        setup({ certs: { "a.com": certJSON(3), "b.com": certJSON(10) } })
      );

      await run(deps);

      expect(deps.sent.length).toEqual(1);
      expect(deps.sent[0].urgent.map((c) => c.domain)).toEqual(["a.com"]);
      expect(deps.sent[0].other.map((c) => c.domain)).toEqual(["b.com"]);
      expect(deps.sent[0].summary).toEqual("1 urgent");
    });

    it("does not email again the next day for the same urgent domain", async function () {
      const deps = withNow(setup({ certs: { "a.com": certJSON(3) } }));

      await run(deps);
      deps.now = NOW + DAY;
      await run(deps);

      expect(deps.sent.length).toEqual(1);
    });

    it("emails again when a cleared domain becomes urgent again", async function () {
      const deps = withNow(setup({ certs: { "a.com": certJSON(3) } }));

      await run(deps);

      deps.client.store.set("ssl:a.com:latest", certJSON(80));
      await run(deps);
      expect(Array.from(deps.client.set("sslcheck:notified"))).toEqual([]);

      deps.client.store.set("ssl:a.com:latest", certJSON(3));
      await run(deps);

      expect(deps.sent.length).toEqual(2);
    });

    it("emails when a new domain becomes urgent alongside a notified one", async function () {
      const deps = withNow(
        setup({ certs: { "a.com": certJSON(3), "b.com": certJSON(20) } })
      );

      await run(deps);
      deps.client.store.set("ssl:b.com:latest", certJSON(2));
      await run(deps);

      expect(deps.sent.length).toEqual(2);
    });

    it("emails when 20 certificates are flagged", async function () {
      const deps = withNow(setup({ certs: many(20, 20) }));

      await run(deps);

      expect(deps.sent.length).toEqual(1);
      expect(deps.sent[0].hasSystemic).toEqual(true);
      expect(deps.sent[0].other.length).toEqual(20);
    });

    it("emails every day while the wildcard needs attention", async function () {
      const deps = setup({});
      deps.now = PEM_EXPIRES - 20 * DAY;

      await run(deps);
      deps.now += DAY;
      await run(deps);

      expect(deps.sent.length).toEqual(2);
      expect(deps.sent[0].summary).toEqual("wildcard certificate");
    });

    it("emails when the wildcard is missing", async function () {
      const deps = setup({});
      deps.client.store.delete("blot:openresty:ssl:pem");

      await run(deps);

      expect(deps.sent.length).toEqual(1);
    });

    it("reports an urgent domain again if the email failed", async function () {
      const deps = withNow(setup({ certs: { "a.com": certJSON(3) } }));
      const sendEmail = deps.sendEmail;
      deps.sendEmail = async () => {
        throw new Error("mailgun down");
      };

      let error;
      try {
        await run(deps);
      } catch (e) {
        error = e;
      }
      expect(error.message).toEqual("mailgun down");

      deps.sendEmail = sendEmail;
      await run(deps);
      expect(deps.sent.length).toEqual(1);
    });
  });
});
