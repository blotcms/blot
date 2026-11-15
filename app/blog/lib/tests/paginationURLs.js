const paginationURLs = require("../paginationURLs");

describe("paginationURLs", function () {
  function urls(req, pagination) {
    const result = paginationURLs(req, pagination);
    return [result.next_url, result.previous_url];
  }

  it("links the index to / and /page/N", function () {
    const req = {
      viewName: "entries.html",
      originalUrl: "/page/2",
      params: { page: "2" },
      query: {},
    };
    expect(urls(req, { current: 2, next: 3, previous: 1 })).toEqual([
      "/page/3",
      "/",
    ]);
  });

  it("links the first page of the index forward only", function () {
    const req = {
      viewName: "entries.html",
      originalUrl: "/",
      params: {},
      query: {},
    };
    expect(urls(req, { current: 1, next: 2, previous: null })).toEqual([
      "/page/2",
      null,
    ]);
  });

  it("links the last page of the index back only", function () {
    const req = {
      viewName: "entries.html",
      originalUrl: "/page/3",
      params: { page: "3" },
      query: {},
    };
    expect(urls(req, { current: 3, next: null, previous: 2 })).toEqual([
      null,
      "/page/2",
    ]);
  });

  it("links tag pages and encodes the slug", function () {
    const req = {
      viewName: "tagged.html",
      originalUrl: "/tagged/caf%C3%A9%20au%20lait/page/2",
      params: { tag: "café au lait", page: "2" },
      query: {},
    };
    expect(urls(req, { current: 2, next: 3, previous: 1 })).toEqual([
      "/tagged/caf%C3%A9%20au%20lait/page/3",
      "/tagged/caf%C3%A9%20au%20lait",
    ]);
  });

  it("links the first tag page forward", function () {
    const req = {
      viewName: "tagged.html",
      originalUrl: "/tagged/foo",
      params: { tag: "foo" },
      query: {},
    };
    expect(urls(req, { current: 1, next: 2, previous: null })).toEqual([
      "/tagged/foo/page/2",
      null,
    ]);
  });

  it("uses a view's own page pattern", function () {
    const req = {
      viewName: "archives.html",
      viewURLPatterns: ["/archives", "/archives/page/:page"],
      originalUrl: "/archives/page/2",
      params: { page: "2" },
      query: {},
    };
    expect(urls(req, { current: 2, next: 3, previous: 1 })).toEqual([
      "/archives/page/3",
      "/archives",
    ]);
  });

  it("fills other parameters of a view pattern", function () {
    const req = {
      viewName: "section.html",
      viewURLPatterns: ["/s/:section/page/:page"],
      originalUrl: "/s/a%20b/page/2",
      params: { section: "a b", page: "2" },
      query: {},
    };
    expect(urls(req, { current: 2, next: 3, previous: 1 })).toEqual([
      "/s/a%20b/page/3",
      "/s/a%20b",
    ]);
  });

  it("uses an optional page group", function () {
    const req = {
      viewName: "archives.html",
      viewURLPatterns: ["/archives{/page/:page}"],
      originalUrl: "/archives/page/2",
      params: { page: "2" },
      query: {},
    };
    expect(urls(req, { current: 2, next: 3, previous: 1 })).toEqual([
      "/archives/page/3",
      "/archives",
    ]);
  });

  it("uses ?page= when the view has no page pattern, keeping other parameters in order", function () {
    const req = {
      viewName: "posts.html",
      viewURLPatterns: ["/posts"],
      originalUrl: "/posts?b=2&page=2&a=x%20y",
      params: {},
      query: { b: "2", page: "2", a: "x y" },
    };
    expect(urls(req, { current: 2, next: 3, previous: 1 })).toEqual([
      "/posts?b=2&page=3&a=x+y",
      "/posts?b=2&a=x+y",
    ]);
  });

  it("adds ?page= after the other query parameters", function () {
    const req = {
      viewName: "posts.html",
      viewURLPatterns: ["/posts"],
      originalUrl: "/posts?q=1",
      params: {},
      query: { q: "1" },
    };
    expect(urls(req, { current: 1, next: 2, previous: null })).toEqual([
      "/posts?q=1&page=2",
      null,
    ]);
  });

  it("falls back to ?page= when a pattern's parameters can't be filled", function () {
    const req = {
      viewName: "tagged.html",
      originalUrl: "/tags?tag=foo",
      params: {},
      query: { tag: "foo" },
    };
    expect(urls(req, { current: 1, next: 2, previous: null })).toEqual([
      "/tags?tag=foo&page=2",
      null,
    ]);
  });

  it("gives null for both on a single page, and keeps the other keys", function () {
    const req = {
      viewName: "entries.html",
      originalUrl: "/",
      params: {},
      query: {},
    };
    expect(
      paginationURLs(req, { current: 1, total: 1, next: null, previous: null })
    ).toEqual({
      current: 1,
      total: 1,
      next: null,
      previous: null,
      next_url: null,
      previous_url: null,
    });
  });

  it("gives null for both on an empty pagination without changing it", function () {
    const pagination = {};
    const result = paginationURLs({ originalUrl: "/" }, pagination);
    expect(result.next_url).toBeNull();
    expect(result.previous_url).toBeNull();
    expect(pagination).toEqual({});
  });
});
