const plugin = require("../plugin");
const Plugins = require("build/plugins");

describe("plugin", function () {
  var originalList;

  beforeEach(function () {
    originalList = Plugins.list;
    Plugins.list = {
      syntax: { publicCSS: "syntax.css", publicJS: "syntax.js" },
    };
  });

  afterEach(function () {
    Plugins.list = originalList;
  });

  function run(req) {
    return new Promise((resolve, reject) => {
      plugin(req, {}, (err, result) => (err ? reject(err) : resolve(result)));
    });
  }

  it("returns css and js for an enabled, requested plugin", async function () {
    const result = await run({
      retrieve: { plugin: { syntax: { css: true, js: true } } },
      blog: { plugins: { syntax: { enabled: true } } },
    });

    expect(result).toEqual({ syntax: { css: "syntax.css", js: "syntax.js" } });
  });

  it("only includes the fields actually requested", async function () {
    const result = await run({
      retrieve: { plugin: { syntax: { css: true } } },
      blog: { plugins: { syntax: { enabled: true } } },
    });

    expect(result).toEqual({ syntax: { css: "syntax.css" } });
  });

  it("omits plugins the blog has not enabled", async function () {
    const result = await run({
      retrieve: { plugin: { syntax: { css: true } } },
      blog: { plugins: { syntax: { enabled: false } } },
    });

    expect(result).toBeUndefined();
  });

  it("omits plugins the blog has not configured at all", async function () {
    const result = await run({
      retrieve: { plugin: { syntax: { css: true } } },
      blog: { plugins: {} },
    });

    expect(result).toBeUndefined();
  });

  it("omits plugins that don't exist in the plugin registry", async function () {
    const result = await run({
      retrieve: { plugin: { missing: { css: true } } },
      blog: { plugins: { missing: { enabled: true } } },
    });

    expect(result).toBeUndefined();
  });

  it("treats a boolean retrieve.plugin request as requesting nothing", async function () {
    const result = await run({
      retrieve: { plugin: true },
      blog: { plugins: { syntax: { enabled: true } } },
    });

    expect(result).toBeUndefined();
  });
});
