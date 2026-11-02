describe("helper/egress", function () {
  const nock = require("nock");
  const http = require("http");
  const config = require("config");
  const egressPath = require.resolve("helper/egress");

  const original = {
    required: config.egress.required,
    proxy: config.egress.proxy,
    browser: config.sandbox.browser,
  };

  // The module reads config.egress at require time, so each spec sets the
  // state it wants and re-requires a fresh copy.
  const load = ({ required, proxy, browser } = {}) => {
    config.egress.required = !!required;
    config.egress.proxy = proxy || null;
    config.sandbox.browser = !!browser;
    delete require.cache[egressPath];
    return require("helper/egress");
  };

  beforeEach(function () {
    nock.disableNetConnect();
  });

  afterEach(function () {
    nock.cleanAll();
    nock.enableNetConnect();
    config.egress.required = original.required;
    config.egress.proxy = original.proxy;
    config.sandbox.browser = original.browser;
    delete require.cache[egressPath];
  });

  it("is a no-op when not required and nothing is configured", function () {
    const egress = load({ required: false });
    expect(egress.required).toBe(false);
    expect(egress.proxyConfigured).toBe(false);
    expect(egress.proxyAgent).toBeUndefined();
    expect(function () {
      egress.assertProxyReady("test");
    }).not.toThrow();
    expect(function () {
      egress.assertBrowserReady("test");
    }).not.toThrow();
  });

  it("throws from assertProxyReady when required but proxy is unset", function () {
    const egress = load({ required: true });
    expect(function () {
      egress.assertProxyReady("some-sink");
    }).toThrowError(/some-sink/);
  });

  it("throws from assertBrowserReady when required but there is no sandbox browser", function () {
    const egress = load({ required: true });
    expect(function () {
      egress.assertBrowserReady("linkScreenshot");
    }).toThrowError(/linkScreenshot/);
  });

  it("does not throw when required and the proxy and sandbox are configured", function () {
    const egress = load({
      required: true,
      proxy: "http://egress:8888",
      browser: true,
    });
    expect(egress.assertProxyReady("x")).toBeUndefined();
    expect(egress.assertBrowserReady("x")).toBeUndefined();
  });

  it("picks an https proxy agent for https targets and http for http", function () {
    const egress = load({ proxy: "http://egress:8888" });
    const httpsAgent = egress.proxyAgent({ protocol: "https:" });
    const httpAgent = egress.proxyAgent({ protocol: "http:" });
    expect(httpsAgent).toBeTruthy();
    expect(httpAgent).toBeTruthy();
    expect(httpsAgent).not.toBe(httpAgent);
    expect(httpsAgent.constructor.name).toBe("HttpsProxyAgent");
    expect(httpAgent.constructor.name).toBe("HttpProxyAgent");
  });

  it("fetch() rejects instead of fetching when required but proxy is unset", async function () {
    const egress = load({ required: true });
    const scope = nock("http://example.com").get("/").reply(200, "ok");
    let threw;
    try {
      await egress.fetch("http://example.com/");
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeDefined();
    expect(threw.message).toMatch(/BLOT_EGRESS_PROXY_URL/);
    expect(scope.isDone()).toBe(false);
  });

  it("fetch() does a direct request when not required and unconfigured", async function () {
    const egress = load({ required: false });
    const scope = nock("http://example.com").get("/").reply(200, "ok");
    const res = await egress.fetch("http://example.com/");
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
      const egress = load({ proxy: "http://egress:8888" });
      egress.getViaIP("93.184.216.34", "/verify/domain-setup", {
        host: "example.com",
      });
      expect(seen.host).toBe("egress");
      expect(String(seen.port)).toBe("8888");
      expect(seen.path).toBe("http://93.184.216.34/verify/domain-setup");
      expect(seen.headers.Host).toBe("example.com");
    });

    it("connects straight to the IP when no proxy is configured", function () {
      const egress = load({ required: false });
      egress.getViaIP("93.184.216.34", "/verify/domain-setup", {
        host: "example.com",
      });
      expect(seen.host).toBe("93.184.216.34");
      expect(seen.path).toBe("/verify/domain-setup");
      expect(seen.headers.Host).toBe("example.com");
    });

    it("resolves { status, text } for a 2xx", async function () {
      const egress = load({ required: false });
      const r = await egress.getViaIP("1.2.3.4", "/verify/domain-setup", {
        host: "example.com",
      });
      expect(r).toEqual({ status: 200, text: "blog_handle" });
    });

    it("follows a redirect off hop 0 through the proxied fetch", async function () {
      const egress = load({ required: false });
      reply = {
        statusCode: 301,
        headers: { location: "https://example.com/verify/domain-setup" },
      };
      const scope = nock("https://example.com")
        .get("/verify/domain-setup")
        .reply(200, "handle-after-redirect");
      const r = await egress.getViaIP("1.2.3.4", "/verify/domain-setup", {
        host: "example.com",
      });
      expect(r).toEqual({ status: 200, text: "handle-after-redirect" });
      expect(scope.isDone()).toBe(true);
    });

    it("rejects when hop 0 errors", async function () {
      const egress = load({ required: false });
      reply = { reqError: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }) };
      let threw;
      try {
        await egress.getViaIP("1.2.3.4", "/verify/domain-setup", { host: "x" });
      } catch (e) {
        threw = e;
      }
      expect(threw && threw.message).toBe("ECONNRESET");
    });

    it("rejects when the response stream aborts", async function () {
      const egress = load({ required: false });
      reply = { statusCode: 200, emit: "aborted" };
      let threw;
      try {
        await egress.getViaIP("1.2.3.4", "/verify/domain-setup", { host: "x" });
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeDefined();
    });

    it("fails closed when required but no proxy is configured", function () {
      const egress = load({ required: true });
      expect(function () {
        egress.getViaIP("93.184.216.34", "/verify/domain-setup", {
          host: "example.com",
        });
      }).toThrowError(/BLOT_EGRESS_PROXY_URL/);
    });
  });
});
