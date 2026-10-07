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

  // The parts of the Redis client the job uses
  function fakeRedis(strings = {}) {
    const store = new Map(Object.entries(strings));
    const sets = new Map();
    let hash = {};

    return {
      store,
      sets,
      get hash() {
        return hash;
      },
      get: async (key) => (store.has(key) ? store.get(key) : null),
      sendCommand: async ([command, ...keys]) => {
        expect(command).toEqual("MGET");
        return keys.map((key) => (store.has(key) ? store.get(key) : null));
      },
      sMembers: async (key) => Array.from(sets.get(key) || []),
      sAdd: async (key, members) => {
        sets.set(key, new Set([...(sets.get(key) || []), ...members]));
      },
      sRem: async (key, members) => {
        members.forEach((member) => sets.get(key) && sets.get(key).delete(member));
      },
      hGetAll: async () => ({ ...hash }),
      hSet: async (key, value) => {
        hash = { ...value };
      },
      del: async () => {
        hash = {};
      },
    };
  }

  const blogOf = (handle, domain, extra = {}) => ({
    id: "blog_" + handle,
    handle,
    domain,
    isDisabled: false,
    ...extra,
  });

  // Redis with domain: keys for the blogs, plus a healthy wildcard
  function setup({ blogs, certs = {}, seen = [], twins = [] }) {
    const strings = {
      "blot:openresty:ssl:pem": PEM,
      "blot:openresty:ssl:updated": String(Math.floor(NOW / 1000)),
    };

    for (const blog of blogs) {
      if (blog.domain && !blog.noDomainKey) strings["domain:" + blog.domain] = blog.id;
    }
    for (const twin of twins) strings["domain:" + twin] = "blog";
    for (const [domain, value] of Object.entries(certs)) {
      strings[`ssl:${domain}:latest`] = value;
    }

    const client = fakeRedis(strings);
    client.sets.set("sslcheck:seen", new Set(seen));

    return {
      client,
      now: NOW,
      listBlogs: async () => blogs,
      verifyDNS: async () => ({ status: "blot" }),
      checkServedCert: async () => ({ validTo: PEM_EXPIRES }),
    };
  }

  const domains = (report) => report.items.map((item) => item.domain).filter(Boolean);

  describe("customer certificates", function () {
    it("ignores a healthy certificate", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": certJSON(25) },
      });

      const report = await check(deps);

      expect(report.items).toEqual([]);
      expect(report.errors).toEqual([]);
      expect(report.observed).toEqual(["a.com"]);
    });

    it("reports a certificate under 25 days as failing", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": certJSON(24) },
      });

      const report = await check(deps);

      expect(report.items.length).toEqual(1);
      expect(report.items[0].domain).toEqual("a.com");
      expect(report.items[0].handle).toEqual("a");
      expect(report.items[0].tier).toEqual("failing");
      expect(report.items[0].daysLeft).toEqual(24);
      expect(report.items[0].expires).toEqual(NOW + 24 * DAY);
    });

    it("reports a certificate under 7 days as urgent", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com"), blogOf("b", "b.com")],
        certs: { "a.com": certJSON(6), "b.com": certJSON(7) },
      });

      const report = await check(deps);

      expect(report.items.map((i) => [i.domain, i.tier])).toEqual([
        ["a.com", "urgent"],
        ["b.com", "failing"],
      ]);
    });

    it("sorts by days left", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com"), blogOf("b", "b.com"), blogOf("c", "c.com")],
        certs: { "a.com": certJSON(20), "b.com": certJSON(3), "c.com": certJSON(10) },
      });

      expect(domains(await check(deps))).toEqual(["b.com", "c.com", "a.com"]);
    });

    it("falls back to the X509 expiry when the entry has none", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": JSON.stringify({ fullchain_pem: PEM }) },
      });
      deps.now = PEM_EXPIRES - 10 * DAY;

      // (the wildcard shares this certificate, so it is expiring too)
      const [item, ...rest] = (await check(deps)).items.filter((i) => i.kind === "cert");

      expect(rest).toEqual([]);
      expect(item.daysLeft).toEqual(10);
      expect(item.expires).toEqual(PEM_EXPIRES);
    });

    it("records malformed entries as errors without leaking them", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com"), blogOf("b", "b.com"), blogOf("c", "c.com")],
        certs: {
          "a.com": `{"privkey_pem":"${SECRET}" nope`,
          "b.com": JSON.stringify({ privkey_pem: SECRET }),
          "c.com": certJSON(5),
        },
      });

      const report = await check(deps);

      expect(domains(report)).toEqual(["c.com"]);
      expect(report.errors.map((e) => e.domain)).toEqual(["a.com", "b.com"]);
      expect(JSON.stringify(report)).not.toContain(SECRET);
    });

    it("ignores disabled blogs, blogs without a domain: key, and blot subdomains", async function () {
      const deps = setup({
        blogs: [
          blogOf("a", "a.com", { isDisabled: true }),
          blogOf("b", "b.com", { noDomainKey: true }),
          blogOf("c", "c." + config.host),
          blogOf("d", ""),
        ],
        certs: {
          "a.com": certJSON(1),
          "b.com": certJSON(1),
          ["c." + config.host]: certJSON(1),
        },
      });

      expect((await check(deps)).items).toEqual([]);
    });

    it("checks the www/apex twin only if it has a domain: key", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com"), blogOf("b", "b.com")],
        twins: ["www.a.com"],
        certs: {
          "www.a.com": certJSON(2),
          "www.b.com": certJSON(2),
        },
      });

      expect(domains(await check(deps))).toEqual(["www.a.com"]);
    });

    it("lists domains whose DNS moved separately, and keeps the rest", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com"), blogOf("b", "b.com")],
        certs: { "a.com": certJSON(10), "b.com": certJSON(10) },
      });
      deps.verifyDNS = async (domain) => ({
        status: domain === "a.com" ? "moved" : "blot",
      });

      const report = await check(deps);

      expect(domains(report)).toEqual(["b.com"]);
      expect(report.ignored.map((i) => i.domain)).toEqual(["a.com"]);
    });

    it("only checks DNS for certificates in trouble", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com"), blogOf("b", "b.com")],
        certs: { "a.com": certJSON(60), "b.com": certJSON(10) },
      });
      const asked = [];
      deps.verifyDNS = async (domain) => {
        asked.push(domain);
        return { status: "blot" };
      };

      await check(deps);

      expect(asked).toEqual(["b.com"]);
    });

    it("keeps proxied domains and domains with extra A records", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com"), blogOf("b", "b.com")],
        certs: { "a.com": certJSON(10), "b.com": certJSON(10) },
      });
      deps.verifyDNS = async (domain) =>
        domain === "a.com"
          ? { status: "proxied" }
          : { status: "mixed", extraIPs: ["162.255.119.153"] };

      const report = await check(deps);

      expect(report.items.find((i) => i.domain === "a.com").proxied).toEqual(true);
      expect(report.items.find((i) => i.domain === "b.com").extraIPs).toEqual([
        "162.255.119.153",
      ]);
      expect(report.ignored).toEqual([]);
      expect(run.view(report, new Set()).certs[0].detail).toContain(
        "Extra A record(s) 162.255.119.153 not pointing at Blot"
      );
      expect(run.view(report, new Set()).proxied.map((i) => i.domain)).toEqual(["a.com"]);
    });

    it("treats a failed DNS check as still pointing at Blot", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": certJSON(10) },
      });
      deps.verifyDNS = async () => {
        throw new Error("timeout");
      };

      expect(domains(await check(deps))).toEqual(["a.com"]);
    });

    it("reports a missing certificate as dropped only for a domain seen before", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com"), blogOf("b", "b.com")],
        seen: ["a.com"],
      });

      const report = await check(deps);

      expect(report.items.map((i) => [i.domain, i.tier])).toEqual([
        ["a.com", "expired-and-dropped"],
      ]);
    });

    it("lists the stale entries of the seen set", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": certJSON(60) },
        seen: ["a.com", "gone.com"],
      });

      expect((await check(deps)).stale).toEqual(["gone.com"]);
    });

    it("flags a systemic failure at 10 failing certificates", async function () {
      const make = (count) => {
        const blogs = [];
        const certs = {};
        for (let i = 0; i < count; i++) {
          blogs.push(blogOf("b" + i, `b${i}.com`));
          certs[`b${i}.com`] = certJSON(20);
        }
        return setup({ blogs, certs });
      };

      expect((await check(make(9))).systemic).toEqual(0);

      const report = await check(make(10));
      expect(report.systemic).toEqual(10);
      expect(run.view(report, new Set()).hasSystemic).toEqual(true);
    });

    it("does not count ignored certificates towards a systemic failure", async function () {
      const blogs = [];
      const certs = {};
      for (let i = 0; i < 10; i++) {
        blogs.push(blogOf("b" + i, `b${i}.com`));
        certs[`b${i}.com`] = certJSON(20);
      }
      const deps = setup({ blogs, certs });
      deps.verifyDNS = async () => ({ status: "moved" });

      expect((await check(deps)).systemic).toEqual(0);
    });
  });

  describe("wildcard certificate", function () {
    const wildcard = (report) => report.items.filter((i) => i.kind === "wildcard");

    it("is quiet when healthy and served", async function () {
      const deps = setup({ blogs: [] });
      deps.now = PEM_EXPIRES - 60 * DAY;

      expect(wildcard(await check(deps))).toEqual([]);
    });

    it("reports a missing certificate as urgent", async function () {
      const deps = setup({ blogs: [] });
      deps.client.store.delete("blot:openresty:ssl:pem");

      const items = wildcard(await check(deps));

      expect(items.map((i) => [i.key, i.tier])).toEqual([["wildcard", "urgent"]]);
    });

    it("reports a certificate that can't be parsed", async function () {
      const deps = setup({ blogs: [] });
      deps.client.store.set("blot:openresty:ssl:pem", "not a certificate");

      const items = wildcard(await check(deps));

      expect(items.map((i) => [i.key, i.tier])).toEqual([["wildcard", "urgent"]]);
      expect(items[0].message).toContain("could not be parsed");
    });

    it("warns under 21 days and is urgent under 7, with the last renewal date", async function () {
      const deps = setup({ blogs: [] });
      deps.now = PEM_EXPIRES - 20 * DAY;
      deps.checkServedCert = async () => ({ validTo: PEM_EXPIRES });
      deps.client.store.set(
        "blot:openresty:ssl:updated",
        String(Date.UTC(2026, 9, 1, 9) / 1000)
      );

      let items = wildcard(await check(deps));
      expect(items.map((i) => i.tier)).toEqual(["warning"]);
      expect(items[0].message).toContain("20 days left");
      expect(items[0].message).toContain("Last renewal run: 2026-10-01");

      deps.now = PEM_EXPIRES - 6 * DAY;
      items = wildcard(await check(deps));
      expect(items.map((i) => i.tier)).toEqual(["urgent"]);
    });

    it("reports a served certificate that expires sooner than the one in Redis", async function () {
      const deps = setup({ blogs: [] });
      deps.now = PEM_EXPIRES - 60 * DAY;
      deps.checkServedCert = async () => ({ validTo: PEM_EXPIRES - 40 * DAY });

      const items = wildcard(await check(deps));

      expect(items.map((i) => [i.key, i.tier])).toEqual([["wildcard-served", "warning"]]);
      expect(items[0].message).toContain("not reloaded");
    });

    it("does not alert on a failed handshake alone", async function () {
      const deps = setup({ blogs: [] });
      deps.now = PEM_EXPIRES - 60 * DAY;
      deps.checkServedCert = async () => {
        throw new Error("ECONNREFUSED");
      };

      expect(wildcard(await check(deps))).toEqual([]);
    });
  });

  describe("emailing", function () {
    function withEmail(deps) {
      const sent = [];
      deps.sendEmail = async (view) => {
        sent.push(view);
      };
      return sent;
    }

    it("emails a new problem once, then stays quiet at the warning tier", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": certJSON(20) },
      });
      const sent = withEmail(deps);

      await run(deps);
      expect(sent.length).toEqual(1);
      expect(sent[0].certs.map((c) => [c.domain, c.isNew])).toEqual([["a.com", true]]);

      deps.now = NOW + DAY;
      await run(deps);
      expect(sent.length).toEqual(1);
    });

    it("emails every day while something is urgent, listing everything", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com"), blogOf("b", "b.com")],
        certs: { "a.com": certJSON(3), "b.com": certJSON(20) },
      });
      const sent = withEmail(deps);

      await run(deps);
      await run(deps);

      expect(sent.length).toEqual(2);
      expect(sent[1].certs.map((c) => [c.domain, c.isNew])).toEqual([
        ["a.com", false],
        ["b.com", false],
      ]);
    });

    it("emails again when a problem escalates", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": certJSON(10) },
      });
      const sent = withEmail(deps);

      await run(deps);
      expect(sent.length).toEqual(1);

      // Same certificate, a week later: now urgent
      deps.now = NOW + 4 * DAY;
      await run(deps);
      expect(sent.length).toEqual(2);
      expect(sent[1].certs[0].isNew).toEqual(true);
    });

    it("emails when a new problem joins one already reported", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com"), blogOf("b", "b.com")],
        certs: { "a.com": certJSON(10), "b.com": certJSON(60) },
      });
      const sent = withEmail(deps);

      await run(deps);
      deps.client.store.set("ssl:b.com:latest", certJSON(20));
      await run(deps);

      expect(sent.length).toEqual(2);
      expect(sent[1].certs.map((c) => [c.domain, c.isNew])).toEqual([
        ["a.com", false],
        ["b.com", true],
      ]);
    });

    it("reports a problem as new again after it cleared", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": certJSON(10) },
      });
      const sent = withEmail(deps);

      await run(deps);
      deps.client.store.set("ssl:a.com:latest", certJSON(80));
      await run(deps);
      deps.client.store.set("ssl:a.com:latest", certJSON(10));
      await run(deps);

      expect(sent.length).toEqual(2);
    });

    it("does not email for ignored domains", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": certJSON(1) },
      });
      deps.verifyDNS = async () => ({ status: "moved" });
      const sent = withEmail(deps);

      const result = await run(deps);

      expect(sent).toEqual([]);
      expect(result.sent).toEqual(false);
    });

    it("emails about the wildcard certificate", async function () {
      const deps = setup({ blogs: [] });
      deps.client.store.delete("blot:openresty:ssl:pem");
      const sent = withEmail(deps);

      await run(deps);

      expect(sent.length).toEqual(1);
      expect(sent[0].hasWildcard).toEqual(true);
      expect(sent[0].summary).toEqual("1 urgent");
    });

    it("reports a certificate Redis lost after it was seen", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": certJSON(60) },
      });
      const sent = withEmail(deps);

      await run(deps);
      expect(sent.length).toEqual(0);
      expect(Array.from(deps.client.sets.get("sslcheck:seen"))).toEqual(["a.com"]);

      deps.client.store.delete("ssl:a.com:latest");
      await run(deps);

      expect(sent.length).toEqual(1);
      expect(sent[0].certs[0].detail).toContain("expired and dropped");
    });

    it("forgets seen domains that left their blogs", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": certJSON(60) },
        seen: ["gone.com"],
      });

      await run(deps);

      expect(Array.from(deps.client.sets.get("sslcheck:seen"))).toEqual(["a.com"]);
    });

    it("reports again next run if the email failed", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": certJSON(20) },
      });
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

      const sent = withEmail(deps);
      await run(deps);
      expect(sent.length).toEqual(1);
    });

    it("emails about unreadable certificates", async function () {
      const deps = setup({
        blogs: [blogOf("a", "a.com")],
        certs: { "a.com": "{" },
      });
      const sent = withEmail(deps);

      await run(deps);
      await run(deps);

      expect(sent.length).toEqual(1);
      expect(sent[0].errors.map((e) => e.domain)).toEqual(["a.com"]);
    });
  });
});
