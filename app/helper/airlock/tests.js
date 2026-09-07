describe("helper/airlock", function () {
  const nock = require("nock");
  const http = require("http");
  const config = require("config");
  const airlockPath = require.resolve("helper/airlock");

  const original = {
    required: config.airlock.required,
    proxy: config.airlock.proxy,
    browser_url: config.airlock.browser_url,
  };

  // The module reads config.airlock at require time, so each spec sets the
  // state it wants and re-requires a fresh copy.
  const load = ({ required, proxy, browser_url } = {}) => {
    config.airlock.required = !!required;
    config.airlock.proxy = proxy || null;
    config.airlock.browser_url = browser_url || null;
    delete require.cache[airlockPath];
    return require("helper/airlock");
  };

  beforeEach(function () {
    nock.disableNetConnect();
  });

  afterEach(function () {
    nock.cleanAll();
    nock.enableNetConnect();
    config.airlock.required = original.required;
    config.airlock.proxy = original.proxy;
    config.airlock.browser_url = original.browser_url;
    delete require.cache[airlockPath];
  });

  it("is a no-op when not required and nothing is configured", function () {
    const airlock = load({ required: false });
    expect(airlock.required).toBe(false);
    expect(airlock.proxyConfigured).toBe(false);
    expect(airlock.proxyAgent).toBeUndefined();
    expect(function () {
      airlock.assertProxyReady("test");
    }).not.toThrow();
    expect(function () {
      airlock.assertBrowserReady("test");
    }).not.toThrow();
  });

  it("throws from assertProxyReady when required but proxy is unset", function () {
    const airlock = load({ required: true });
    expect(function () {
      airlock.assertProxyReady("some-sink");
    }).toThrowError(/some-sink/);
  });

  it("throws from assertBrowserReady when required but browser_url is unset", function () {
    const airlock = load({ required: true });
    expect(function () {
      airlock.assertBrowserReady("linkScreenshot");
    }).toThrowError(/linkScreenshot/);
  });

  it("does not throw when required and the airlock is configured", function () {
    const airlock = load({
      required: true,
      proxy: "http://airlock:8888",
      browser_url: "http://airlock:9222",
    });
    expect(airlock.assertProxyReady("x")).toBeUndefined();
    expect(airlock.assertBrowserReady("x")).toBeUndefined();
  });

  it("picks an https proxy agent for https targets and http for http", function () {
    const airlock = load({ proxy: "http://airlock:8888" });
    const httpsAgent = airlock.proxyAgent({ protocol: "https:" });
    const httpAgent = airlock.proxyAgent({ protocol: "http:" });
    expect(httpsAgent).toBeTruthy();
    expect(httpAgent).toBeTruthy();
    expect(httpsAgent).not.toBe(httpAgent);
    expect(httpsAgent.constructor.name).toBe("HttpsProxyAgent");
    expect(httpAgent.constructor.name).toBe("HttpProxyAgent");
  });

  it("fetch() rejects instead of fetching when required but proxy is unset", async function () {
    const airlock = load({ required: true });
    const scope = nock("http://example.com").get("/").reply(200, "ok");
    let threw;
    try {
      await airlock.fetch("http://example.com/");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(threw.message).toMatch(/BLOT_AIRLOCK_PROXY_URL/);
    expect(scope.isDone()).toBe(false);
  });

  it("fetch() does a direct request when not required and unconfigured", async function () {
    const airlock = load({ required: false });
    const scope = nock("http://example.com").get("/").reply(200, "ok");
    const res = await airlock.fetch("http://example.com/");
    expect(res.status).toBe(200);
    expect(scope.isDone()).toBe(true);
  });

  describe("getViaIP", function () {
    // Stub http.request so hop 0 never hits the network - the point of
    // getViaIP is the request shape and the error/redirect handling. Set
    // `reply` per spec to control the fake response.
    let seen;
    let reply;
    let reqListeners;

    beforeEach(function () {
      seen = null;
      reply = { statusCode: 200, headers: {}, body: "blog_handle" };
      reqListeners = {};

      spyOn(http, "request").and.callFake(function (options, cb) {
        seen = options;
        const res = {
          statusCode: reply.statusCode,
          headers: reply.headers || {},
          setEncoding() {},
          resume() {},
          on(ev, handler) {
            if (ev === "data" && reply.body != null && reply.statusCode < 300)
              handler(reply.body);
            if (ev === "end" && reply.statusCode < 300) handler();
            if (ev === reply.emit) handler(reply.emitArg);
          },
        };
        return {
          destroy() {},
          on(ev, handler) {
            reqListeners[ev] = handler;
          },
          end() {
            if (reply.reqError) return reqListeners.error(reply.reqError);
            cb(res);
          },
        };
      });
    });

    it("sends an absolute-URI request line to the proxy, pinned to the IP", function () {
      const airlock = load({ proxy: "http://airlock:8888" });
      airlock.getViaIP("93.184.216.34", "/verify/domain-setup", {
        host: "example.com",
      });
      expect(seen.host).toBe("airlock");
      expect(String(seen.port)).toBe("8888");
      expect(seen.path).toBe("http://93.184.216.34/verify/domain-setup");
      expect(seen.headers.Host).toBe("example.com");
    });

    it("connects straight to the IP when no proxy is configured", function () {
      const airlock = load({ required: false });
      airlock.getViaIP("93.184.216.34", "/verify/domain-setup", {
        host: "example.com",
      });
      expect(seen.host).toBe("93.184.216.34");
      expect(seen.path).toBe("/verify/domain-setup");
      expect(seen.headers.Host).toBe("example.com");
    });

    it("resolves { status, text } for a 2xx", async function () {
      const airlock = load({ required: false });
      const r = await airlock.getViaIP("1.2.3.4", "/verify/domain-setup", {
        host: "example.com",
      });
      expect(r).toEqual({ status: 200, text: "blog_handle" });
    });

    it("follows a redirect off hop 0 through the proxied fetch", async function () {
      const airlock = load({ required: false });
      reply = {
        statusCode: 301,
        headers: { location: "https://example.com/verify/domain-setup" },
      };
      const scope = nock("https://example.com")
        .get("/verify/domain-setup")
        .reply(200, "handle-after-redirect");
      const r = await airlock.getViaIP("1.2.3.4", "/verify/domain-setup", {
        host: "example.com",
      });
      expect(r).toEqual({ status: 200, text: "handle-after-redirect" });
      expect(scope.isDone()).toBe(true);
    });

    it("rejects when hop 0 errors", async function () {
      const airlock = load({ required: false });
      reply = { reqError: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) };
      let threw;
      try {
        await airlock.getViaIP("1.2.3.4", "/verify/domain-setup", { host: "x" });
      } catch (e) {
        threw = e;
      }
      expect(threw && threw.message).toBe("ECONNRESET");
    });

    it("rejects when the response stream aborts", async function () {
      const airlock = load({ required: false });
      reply = { statusCode: 200, emit: "aborted" };
      let threw;
      try {
        await airlock.getViaIP("1.2.3.4", "/verify/domain-setup", { host: "x" });
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeDefined();
    });

    it("fails closed when required but no proxy is configured", function () {
      const airlock = load({ required: true });
      expect(function () {
        airlock.getViaIP("93.184.216.34", "/verify/domain-setup", {
          host: "example.com",
        });
      }).toThrowError(/BLOT_AIRLOCK_PROXY_URL/);
    });
  });
});
