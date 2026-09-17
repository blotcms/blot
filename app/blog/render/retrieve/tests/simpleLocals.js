const avatarUrl = require("../avatar_url");
const cssUrl = require("../css_url");
const feedUrl = require("../feed_url");
const scriptUrl = require("../script_url");
const searchQuery = require("../search_query");
const totalPosts = require("../total_posts");
const encodeJSON = require("../encode_json");
const encodeURIComponentLocal = require("../encode_uri_component");
const Entries = require("models/entries");

function run(fn, req) {
  return new Promise((resolve, reject) => {
    fn(req, {}, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function getLambda(fn, req) {
  return new Promise((resolve, reject) => {
    fn(req || {}, {}, (err, factory) =>
      err ? reject(err) : resolve(factory())
    );
  });
}

describe("simple pass-through retrieve locals", function () {
  it("avatar_url returns the blog's avatar", async function () {
    const result = await run(avatarUrl, {
      blog: { avatar: "https://cdn/avatar.png" },
    });
    expect(result).toEqual("https://cdn/avatar.png");
  });

  it("css_url returns the blog's stylesheet URL", async function () {
    const result = await run(cssUrl, { blog: { cssURL: "/style.css?cache=1" } });
    expect(result).toEqual("/style.css?cache=1");
  });

  it("feed_url returns the blog's feed URL", async function () {
    const result = await run(feedUrl, { blog: { feedURL: "/feed" } });
    expect(result).toEqual("/feed");
  });

  it("script_url returns the blog's script URL", async function () {
    const result = await run(scriptUrl, {
      blog: { scriptURL: "/script.js?cache=1" },
    });
    expect(result).toEqual("/script.js?cache=1");
  });

  it("search_query returns the q query parameter", async function () {
    const result = await run(searchQuery, { query: { q: "hello" } });
    expect(result).toEqual("hello");
  });

  it("search_query joins a repeated q query parameter", async function () {
    const result = await run(searchQuery, { query: { q: ["hello", "world"] } });
    expect(result).toEqual("hello world");
  });

  it("total_posts returns the blog's total entry count", async function () {
    totalPosts._clear();
    spyOn(Entries, "getTotal").and.callFake((blogID, cb) => cb(null, 42));

    const result = await run(totalPosts, { blog: { id: "blog-1" } });

    expect(result).toEqual(42);
    expect(Entries.getTotal).toHaveBeenCalledWith(
      "blog-1",
      jasmine.any(Function)
    );
  });
});

describe("total_posts cache", function () {
  const totalPosts = require("../total_posts");
  const Entries = require("models/entries");

  beforeEach(function () {
    totalPosts._clear();
  });

  function makeReq(blog) {
    return { blog, log: function () {} };
  }

  it("reuses cached totals for identical cacheIDs", function (done) {
    spyOn(Entries, "getTotal").and.callFake(function (blogID, callback) {
      callback(null, 42);
    });

    const req = makeReq({ id: "blog-1", cacheID: 100 });

    totalPosts(req, {}, function () {
      totalPosts(req, {}, function () {
        expect(Entries.getTotal).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it("refetches when cacheID changes", function (done) {
    spyOn(Entries, "getTotal").and.callFake(function (blogID, callback) {
      callback(null, 42);
    });

    totalPosts(makeReq({ id: "blog-1", cacheID: 100 }), {}, function () {
      totalPosts(makeReq({ id: "blog-1", cacheID: 101 }), {}, function () {
        expect(Entries.getTotal).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });

  it("keys totals per blog so one site cannot read another's count", function (done) {
    spyOn(Entries, "getTotal").and.callFake(function (blogID, callback) {
      callback(null, blogID === "blog-1" ? 1 : 99);
    });

    totalPosts(makeReq({ id: "blog-1", cacheID: 100 }), {}, function (err, first) {
      expect(first).toBe(1);

      totalPosts(makeReq({ id: "blog-2", cacheID: 100 }), {}, function (err, second) {
        expect(second).toBe(99);
        expect(Entries.getTotal).toHaveBeenCalledTimes(2);
        done();
      });
    });
  });
});

describe("encode_json", function () {
  it("escapes characters mustache's default escaping leaves alone, e.g. newlines", async function () {
    const lambda = await getLambda(encodeJSON);
    const render = (text) => text;

    expect(lambda("Hello\nWorld", render)).toEqual("Hello\\nWorld");
  });

  it("returns the rendered text unchanged if it cannot be JSON encoded", async function () {
    const lambda = await getLambda(encodeJSON);
    // JSON.stringify throws on a BigInt - exercises the catch branch.
    const unserializable = 10n;
    const render = () => unserializable;

    expect(lambda("ignored", render)).toBe(unserializable);
  });
});

describe("encode_uri_component", function () {
  it("percent-encodes the rendered text", async function () {
    const lambda = await getLambda(encodeURIComponentLocal);
    const render = (text) => text;

    expect(lambda("A/B?c=d", render)).toEqual(encodeURIComponent("A/B?c=d"));
  });

  it("returns the rendered text unchanged if it cannot be encoded", async function () {
    const lambda = await getLambda(encodeURIComponentLocal);
    // A lone surrogate makes encodeURIComponent throw a URIError.
    const malformed = "\uD800";
    const render = () => malformed;

    expect(lambda("ignored", render)).toEqual(malformed);
  });
});
