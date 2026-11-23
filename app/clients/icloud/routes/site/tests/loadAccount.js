const loadAccountPath = require.resolve("../middleware/loadAccount");
const databasePath = require.resolve("../../../database");
const blogPath = require.resolve("models/blog");

describe("icloud loadAccount middleware", function () {
  const originals = new Map();

  const mockModule = (modulePath, exportsValue) => {
    if (!originals.has(modulePath)) {
      const cached = require.cache[modulePath];
      originals.set(modulePath, cached ? cached.exports : undefined);
    }
    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports: exportsValue,
    };
  };

  afterEach(function () {
    for (const [modulePath, exportsValue] of originals.entries()) {
      if (typeof exportsValue === "undefined") delete require.cache[modulePath];
      else
        require.cache[modulePath] = {
          id: modulePath,
          filename: modulePath,
          loaded: true,
          exports: exportsValue,
        };
    }
    originals.clear();
    delete require.cache[loadAccountPath];
  });

  const account = { sharingLink: "https://www.icloud.com/iclouddrive/x" };

  const run = async ({ account: stored, blog }) => {
    mockModule(databasePath, { get: async () => stored });
    mockModule(blogPath, { get: async () => blog });
    // Another spec may have loaded it with the real database
    delete require.cache[loadAccountPath];
    const loadAccount = require(loadAccountPath);

    const req = { header: (name) => (name === "blogID" ? "blog_a" : null) };
    const res = {
      statusCode: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      send() {
        return this;
      },
    };
    let nextCalled = false;
    await loadAccount(req, res, (error) => {
      if (error) throw error;
      nextCalled = true;
    });
    return { req, res, nextCalled };
  };

  it("loads the account of a connected iCloud blog", async function () {
    const { req, nextCalled } = await run({
      account,
      blog: { id: "blog_a", client: "icloud" },
    });
    expect(nextCalled).toBe(true);
    expect(req.account).toBe(account);
  });

  it("answers 400 for a blog with no iCloud account", async function () {
    const { res, nextCalled } = await run({
      account: null,
      blog: { id: "blog_a", client: "icloud" },
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(400);
  });

  it("answers 410 for a deleted blog", async function () {
    const { res, nextCalled } = await run({ account, blog: null });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(410);
  });

  it("answers 410 for a disabled blog", async function () {
    const { res, nextCalled } = await run({
      account,
      blog: { id: "blog_a", client: "icloud", isDisabled: true },
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(410);
  });

  it("answers 410 for a blog switched to another client", async function () {
    const { res, nextCalled } = await run({
      account,
      blog: { id: "blog_a", client: "dropbox" },
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(410);
  });
});
