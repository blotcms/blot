describe("sync/fix", function () {
  var Blog = require("models/blog");

  var checkNames = [
    "entry-ghosts",
    "tag-ghosts",
    "list-ghosts",
    "menu-ghosts",
    "entries-path-index",
  ];

  var indexPath = require.resolve("../index");
  var checkPaths = checkNames.map(function (name) {
    return require.resolve("../" + name);
  });

  var restoreCache;

  // index.js resolves its dependencies via require() at module-load time,
  // so to stub a check we have to replace the cache entry *before* index.js
  // itself is (re-)required. Returns the freshly (re-)loaded fix function.
  function loadFixWithStubs(stubsByName) {
    var originalIndexModule = require.cache[indexPath];
    var originalCheckModules = {};

    delete require.cache[indexPath];

    checkNames.forEach(function (name, i) {
      var path = checkPaths[i];
      originalCheckModules[name] = require.cache[path];

      require.cache[path] = {
        id: path,
        filename: path,
        loaded: true,
        exports: stubsByName[name],
      };
    });

    restoreCache = function () {
      if (originalIndexModule) {
        require.cache[indexPath] = originalIndexModule;
      } else {
        delete require.cache[indexPath];
      }

      checkNames.forEach(function (name, i) {
        var path = checkPaths[i];
        if (originalCheckModules[name]) {
          require.cache[path] = originalCheckModules[name];
        } else {
          delete require.cache[path];
        }
      });
    };

    return require("../index");
  }

  afterEach(function () {
    if (restoreCache) restoreCache();
    restoreCache = null;
  });

  var clean = async function (blog) {
    return [];
  };

  it("rejects when called without a blog", async function () {
    var fix = require("../index");
    try {
      await fix(undefined);
      fail("expected a rejection");
    } catch (err) {
      expect(err instanceof TypeError).toBe(true);
    }
  });

  it("keeps getRunningChecks", function () {
    var fix = require("../index");
    expect(typeof fix.getRunningChecks).toBe("function");
    expect(Array.isArray(fix.getRunningChecks())).toBe(true);
  });

  it("resolves an empty report and does not touch the blog when nothing is wrong", async function () {
    var fix = loadFixWithStubs({
      "entry-ghosts": clean,
      "tag-ghosts": clean,
      "list-ghosts": clean,
      "menu-ghosts": clean,
      "entries-path-index": clean,
    });

    spyOn(Blog, "set");

    var report = await fix({ id: "blog-id" });
    expect(report).toEqual({});
    expect(Blog.set).not.toHaveBeenCalled();
  });

  it("bumps the blog's cacheID when a check reports a fix", async function () {
    var reported = async function (blog) {
      return ["fixed something"];
    };

    var fix = loadFixWithStubs({
      "entry-ghosts": reported,
      "tag-ghosts": clean,
      "list-ghosts": clean,
      "menu-ghosts": clean,
      "entries-path-index": clean,
    });

    spyOn(Blog, "set").and.callFake(async function (blogID, updates) {
      expect(blogID).toBe("blog-id");
      expect(typeof updates.cacheID).toBe("number");
    });

    var report = await fix({ id: "blog-id" });
    expect(report).toEqual({ "entry-ghosts": ["fixed something"] });
    expect(Blog.set).toHaveBeenCalled();
  });

  it("does not email the admin about what it repaired - callers report the returned report", async function () {
    var email = require("helper/email");
    var reported = async function (blog) {
      return ["fixed something"];
    };

    var fix = loadFixWithStubs({
      "entry-ghosts": reported,
      "tag-ghosts": clean,
      "list-ghosts": clean,
      "menu-ghosts": clean,
      "entries-path-index": clean,
    });

    Object.keys(email).forEach(function (name) {
      if (typeof email[name] === "function") spyOn(email, name);
    });
    spyOn(Blog, "set").and.callFake(async function (blogID, updates) {});

    var report = await fix({ id: "blog-id" });
    expect(report).toEqual({ "entry-ghosts": ["fixed something"] });
    Object.keys(email).forEach(function (name) {
      if (typeof email[name] === "function") {
        expect(email[name]).not.toHaveBeenCalled();
      }
    });
  });

  it("reports progress through the status callback in order", async function () {
    var fix = loadFixWithStubs({
      "entry-ghosts": clean,
      "tag-ghosts": clean,
      "list-ghosts": clean,
      "menu-ghosts": clean,
      "entries-path-index": clean,
    });

    var statuses = [];

    await fix(
      { id: "blog-id" },
      {
        status: function (message) {
          statuses.push(message);
        },
      }
    );

    expect(statuses).toEqual([
      "(1/5) Checking entry-ghosts",
      "(2/5) Checking tag-ghosts",
      "(3/5) Checking list-ghosts",
      "(4/5) Checking menu-ghosts",
      "(5/5) Checking entries-path-index",
    ]);
  });

  it("rejects with a status function's error and an empty report", async function () {
    var statusError = new Error("status exploded");
    var fix = loadFixWithStubs({
      "entry-ghosts": clean,
      "tag-ghosts": clean,
      "list-ghosts": clean,
      "menu-ghosts": clean,
      "entries-path-index": clean,
    });

    try {
      await fix(
        { id: "blog-id" },
        {
          status: function () {
            throw statusError;
          },
        }
      );
      fail("expected a rejection");
    } catch (err) {
      expect(err).toBe(statusError);
      expect(err.report).toEqual({});
    }
  });

  it("stops running further checks once one errors, and still surfaces the error", async function () {
    var checkError = new Error("tag-ghosts exploded");
    var listGhostsCalled = false;

    var fix = loadFixWithStubs({
      "entry-ghosts": clean,
      "tag-ghosts": async function (blog) {
        throw checkError;
      },
      "list-ghosts": async function (blog) {
        listGhostsCalled = true;
        return [];
      },
      "menu-ghosts": clean,
      "entries-path-index": clean,
    });

    try {
      await fix({ id: "blog-id" });
      fail("expected a rejection");
    } catch (err) {
      expect(err).toBe(checkError);
      expect(err.report).toEqual({});
      expect(listGhostsCalled).toBe(false);
    }
  });

  it("still surfaces a check's error, with the earlier repairs as err.report, when the cacheID bump succeeds", async function () {
    var checkError = new Error("tag-ghosts exploded");

    var fix = loadFixWithStubs({
      "entry-ghosts": async function (blog) {
        return ["fixed something"];
      },
      "tag-ghosts": async function (blog) {
        throw checkError;
      },
      "list-ghosts": clean,
      "menu-ghosts": clean,
      "entries-path-index": clean,
    });

    spyOn(Blog, "set").and.callFake(async function (blogID, updates) {});

    try {
      await fix({ id: "blog-id" });
      fail("expected a rejection");
    } catch (err) {
      expect(err).toBe(checkError);
      expect(err.report).toEqual({ "entry-ghosts": ["fixed something"] });
      expect(Blog.set).toHaveBeenCalled();
      // Not enumerable, so logging the error prints what it did before
      expect(Object.keys(err)).not.toContain("report");
    }
  });

  it("rejects with the cacheID bump's error, with the repairs as err.report", async function () {
    var setError = new Error("set exploded");

    var fix = loadFixWithStubs({
      "entry-ghosts": async function (blog) {
        return ["fixed something"];
      },
      "tag-ghosts": clean,
      "list-ghosts": clean,
      "menu-ghosts": clean,
      "entries-path-index": clean,
    });

    spyOn(Blog, "set").and.callFake(async function () {
      throw setError;
    });

    try {
      await fix({ id: "blog-id" });
      fail("expected a rejection");
    } catch (err) {
      expect(err).toBe(setError);
      expect(err.report).toEqual({ "entry-ghosts": ["fixed something"] });
    }
  });
});
