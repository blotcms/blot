describe("helper/egress", function () {
  const config = require("config");
  const egressPath = require.resolve("helper/egress");

  const original = {
    required: config.egress.required,
    browser: config.sandbox.browser,
  };

  // The module reads config at require time, so each spec sets the state it
  // wants and re-requires a fresh copy.
  const load = ({ required, browser } = {}) => {
    config.egress.required = !!required;
    config.sandbox.browser = !!browser;
    delete require.cache[egressPath];
    return require("helper/egress");
  };

  afterEach(function () {
    config.egress.required = original.required;
    config.sandbox.browser = original.browser;
    delete require.cache[egressPath];
  });

  it("is a no-op when not required and nothing is configured", function () {
    const egress = load({ required: false });
    expect(egress.required).toBe(false);
    expect(function () {
      egress.assertBrowserReady("test");
    }).not.toThrow();
  });

  it("throws from assertBrowserReady when required but there is no sandbox browser", function () {
    const egress = load({ required: true });
    expect(function () {
      egress.assertBrowserReady("linkScreenshot");
    }).toThrowError(/linkScreenshot/);
  });

  it("does not throw when required and the sandbox is configured", function () {
    const egress = load({ required: true, browser: true });
    expect(egress.assertBrowserReady("x")).toBeUndefined();
  });

  it("no longer fetches: that is the sandbox's fetch job", function () {
    const egress = load({});
    expect(egress.fetch).toBeUndefined();
    expect(egress.getViaIP).toBeUndefined();
  });
});
