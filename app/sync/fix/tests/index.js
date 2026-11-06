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

  it("throws when called without a blog", function () {
    var fix = require("../index");
    expect(function () {
      fix(undefined, function () {});
    }).toThrowError(TypeError);
  });

  it("throws when called without a callback", function () {
    var fix = require("../index");
    expect(function () {
      fix({ id: "blog-id" }, {});
    }).toThrowError(TypeError);
  });

  it("returns an empty report and does not touch the blog when nothing is wrong", function (done) {
    var clean = async function (blog) {
      return [];
    };

    var fix = loadFixWithStubs({
      "entry-ghosts": clean,
      "tag-ghosts": clean,
      "list-ghosts": clean,
      "menu-ghosts": clean,
      "entries-path-index": clean,
    });

    spyOn(Blog, "set");

    fix({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual({});
      expect(Blog.set).not.toHaveBeenCalled();
      done();
    });
  });

  it("bumps the blog's cacheID when a check reports a fix", function (done) {
    var clean = async function (blog) {
      return [];
    };
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

    fix({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual({ "entry-ghosts": ["fixed something"] });
      expect(Blog.set).toHaveBeenCalled();
      done();
    });
  });

  it("does not email the admin about what it repaired - callers report the returned report", function (done) {
    var email = require("helper/email");
    var reported = async function (blog) {
      return ["fixed something"];
    };
    var clean = async function (blog) {
      return [];
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

    fix({ id: "blog-id" }, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual({ "entry-ghosts": ["fixed something"] });
      Object.keys(email).forEach(function (name) {
        if (typeof email[name] === "function") {
          expect(email[name]).not.toHaveBeenCalled();
        }
      });
      done();
    });
  });

  it("reports progress through the status callback in order", function (done) {
    var clean = async function (blog) {
      return [];
    };

    var fix = loadFixWithStubs({
      "entry-ghosts": clean,
      "tag-ghosts": clean,
      "list-ghosts": clean,
      "menu-ghosts": clean,
      "entries-path-index": clean,
    });

    var statuses = [];

    fix(
      { id: "blog-id" },
      {
        status: function (message) {
          statuses.push(message);
        },
      },
      function (err) {
        expect(err).toBeNull();
        expect(statuses).toEqual([
          "(1/5) Checking entry-ghosts",
          "(2/5) Checking tag-ghosts",
          "(3/5) Checking list-ghosts",
          "(4/5) Checking menu-ghosts",
          "(5/5) Checking entries-path-index",
        ]);
        done();
      }
    );
  });

  it("stops running further checks once one errors, and still surfaces the error", function (done) {
    var checkError = new Error("tag-ghosts exploded");
    var listGhostsCalled = false;

    var fix = loadFixWithStubs({
      "entry-ghosts": async function (blog) {
        return [];
      },
      "tag-ghosts": async function (blog) {
        throw checkError;
      },
      "list-ghosts": async function (blog) {
        listGhostsCalled = true;
        return [];
      },
      "menu-ghosts": async function (blog) {
        return [];
      },
      "entries-path-index": async function (blog) {
        return [];
      },
    });

    fix({ id: "blog-id" }, function (err) {
      expect(err).toBe(checkError);
      expect(listGhostsCalled).toBe(false);
      done();
    });
  });

  it("still surfaces a check's error even when an earlier check already found something to fix and the cacheID bump succeeds", function (done) {
    var checkError = new Error("tag-ghosts exploded");

    var fix = loadFixWithStubs({
      "entry-ghosts": async function (blog) {
        return ["fixed something"];
      },
      "tag-ghosts": async function (blog) {
        throw checkError;
      },
      "list-ghosts": async function (blog) {
        return [];
      },
      "menu-ghosts": async function (blog) {
        return [];
      },
      "entries-path-index": async function (blog) {
        return [];
      },
    });

    spyOn(Blog, "set").and.callFake(async function (blogID, updates) {});

    fix({ id: "blog-id" }, function (err, report) {
      expect(err).toBe(checkError);
      expect(report).toEqual({ "entry-ghosts": ["fixed something"] });
      done();
    });
  });
});
