describe("sync/fix/menu-ghosts", function () {
  var Entry = require("models/entry");
  var Blog = require("models/blog");
  var fixMenuGhosts = require("../menu-ghosts");
  // Resolves to { err, report } instead of rejecting, so a spec can
  // assert on either
  const settle_fixMenuGhosts = (...args) =>
    fixMenuGhosts(...args).then(
      (report) => ({ err: null, report }),
      (err) => ({ err, report: undefined })
    );

  it("does not touch the blog when the menu needs no changes", async function () {
    var item = { id: "/foo", label: "Foo", url: "/foo", metadata: {} };
    var blog = { id: "blog-id", menu: [item] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return Promise.resolve({
        id: "/foo",
        title: "Foo",
        url: "/foo",
        metadata: {},
      });
    });
    spyOn(Blog, "set");

    const { err, report } = await settle_fixMenuGhosts(blog);
    expect(err).toBeNull();
    expect(report).toEqual([]);
    expect(Blog.set).not.toHaveBeenCalled();
  });

  it("removes a menu item whose entry has been deleted", async function () {
    var item = { id: "/gone", label: "Gone", url: "/gone", metadata: {} };
    var blog = { id: "blog-id", menu: [item] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return Promise.resolve({ id: "/gone", deleted: true });
    });
    // what is stored, before Fix() edits blog.menu in place
    var stored = JSON.parse(JSON.stringify(blog.menu));
    spyOn(Blog, "get").and.callFake(async function (by) {
      return { id: blog.id, menu: stored };
    });
    spyOn(Blog, "set").and.callFake(async function (blogID, updates) {
      expect(updates.menu).toEqual([]);
    });

    const { err, report } = await settle_fixMenuGhosts(blog);
    expect(err).toBeNull();
    expect(report).toEqual([["Delete", item]]);
    expect(Blog.set).toHaveBeenCalled();
  });

  it("keeps a menu item whose id does not correspond to any entry", async function () {
    var item = {
      id: "https://example.com",
      label: "External",
      url: "https://example.com",
    };
    var blog = { id: "blog-id", menu: [item] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return Promise.resolve(undefined);
    });
    spyOn(Blog, "set");

    const { err, report } = await settle_fixMenuGhosts(blog);
    expect(err).toBeNull();
    expect(report).toEqual([]);
    expect(Blog.set).not.toHaveBeenCalled();
  });

  it("updates a menu item's label, metadata and url to match its entry", async function () {
    var item = {
      id: "/foo",
      label: "Old label",
      url: "/old-url",
      metadata: { old: true },
    };
    var blog = { id: "blog-id", menu: [item] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return Promise.resolve({
        id: "/foo",
        title: "New label",
        url: "/new-url",
        metadata: { old: false },
      });
    });
    // what is stored, before Fix() edits blog.menu in place
    var stored = JSON.parse(JSON.stringify(blog.menu));
    spyOn(Blog, "get").and.callFake(async function (by) {
      return { id: blog.id, menu: stored };
    });
    spyOn(Blog, "set").and.callFake(async function (blogID, updates) {
      expect(updates.menu).toEqual([
        {
          id: "/foo",
          label: "New label",
          url: "/new-url",
          metadata: { old: false },
        },
      ]);
    });

    const { err, report } = await settle_fixMenuGhosts(blog);
    expect(err).toBeNull();
    expect(report).toEqual([
      ["Changed label of", item],
      ["Changed metadata of", item],
      ["Changed URL of", item],
    ]);
    expect(Blog.set).toHaveBeenCalled();
  });

  it("removes a menu item that duplicates an entry already kept in the menu", async function () {
    var first = { id: "/foo", label: "Foo", url: "/foo", metadata: {} };
    var second = { id: "/foo", label: "Foo (dupe)", url: "/foo", metadata: {} };
    var blog = { id: "blog-id", menu: [first, second] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return Promise.resolve({
        id: "/foo",
        title: "Foo",
        url: "/foo",
        metadata: {},
      });
    });
    // what is stored, before Fix() edits blog.menu in place
    var stored = JSON.parse(JSON.stringify(blog.menu));
    spyOn(Blog, "get").and.callFake(async function (by) {
      return { id: blog.id, menu: stored };
    });
    spyOn(Blog, "set").and.callFake(async function (blogID, updates) {
      expect(updates.menu).toEqual([first]);
    });

    const { err, report } = await settle_fixMenuGhosts(blog);
    expect(err).toBeNull();
    expect(report).toEqual([["Delete duplicate", second]]);
    expect(Blog.set).toHaveBeenCalled();
  });

  it("propagates an error from Blog.set", async function () {
    var setError = new Error("set exploded");
    var item = { id: "/gone", label: "Gone", url: "/gone", metadata: {} };
    var blog = { id: "blog-id", menu: [item] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return Promise.resolve({ id: "/gone", deleted: true });
    });
    // what is stored, before Fix() edits blog.menu in place
    var stored = JSON.parse(JSON.stringify(blog.menu));
    spyOn(Blog, "get").and.callFake(async function (by) {
      return { id: blog.id, menu: stored };
    });
    spyOn(Blog, "set").and.callFake(async function (blogID, updates) {
      throw setError;
    });

    const { err } = await settle_fixMenuGhosts(blog);
    expect(err).toBe(setError);
  });

  it("keeps a menu item added by a concurrent sync after the menu was read", async function () {
    var ghost = { id: "/gone", label: "Gone", url: "/gone", metadata: {} };
    var kept = { id: "/foo", label: "Foo", url: "/foo", metadata: {} };
    var added = { id: "/new", label: "New", url: "/new", metadata: {} };
    var blog = { id: "blog-id", menu: [ghost, kept] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      if (id === "/gone")
        return Promise.resolve({ id: "/gone", deleted: true });
      return Promise.resolve({
        id: "/foo",
        title: "Foo",
        url: "/foo",
        metadata: {},
      });
    });
    // By the time the fix writes, the menu has gained an item
    spyOn(Blog, "get").and.callFake(async function (by) {
      return { id: blog.id, menu: [ghost, kept, added] };
    });
    spyOn(Blog, "set").and.callFake(async function (blogID, updates) {
      expect(updates.menu).toEqual([kept, added]);
    });

    const { err, report } = await settle_fixMenuGhosts(blog);
    expect(err).toBeNull();
    expect(report).toEqual([["Delete", ghost]]);
    expect(Blog.set).toHaveBeenCalled();
  });

  it("does not write when a concurrent change already removed the ghost", async function () {
    var ghost = { id: "/gone", label: "Gone", url: "/gone", metadata: {} };
    var blog = { id: "blog-id", menu: [ghost] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return Promise.resolve({ id: "/gone", deleted: true });
    });
    spyOn(Blog, "get").and.callFake(async function (by) {
      return { id: blog.id, menu: [] };
    });
    spyOn(Blog, "set");

    const { err } = await settle_fixMenuGhosts(blog);
    expect(err).toBeNull();
    expect(Blog.set).not.toHaveBeenCalled();
  });

  it("removes a duplicate whose raw id differs but normalizes to the same entry", async function () {
    var nfc = "/caf\u00e9.txt";
    var nfd = "/cafe\u0301.txt";
    var first = { id: nfc, label: "Cafe", url: "/cafe", metadata: {} };
    var second = { id: nfd, label: "Cafe", url: "/cafe", metadata: {} };
    var blog = { id: "blog-id", menu: [first, second] };
    var stored = JSON.parse(JSON.stringify(blog.menu));

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return new Promise(function (resolve) {
        // both ids resolve to the same entry, whose id is the NFC form
        setTimeout(
          function () {
            resolve({ id: nfc, title: "Cafe", url: "/cafe", metadata: {} });
          },
          id === nfc ? 0 : 5
        );
      });
    });
    spyOn(Blog, "get").and.callFake(async function (by) {
      return { id: blog.id, menu: stored };
    });
    spyOn(Blog, "set").and.callFake(async function (blogID, updates) {
      expect(updates.menu).toEqual([first]);
    });

    const { err, report } = await settle_fixMenuGhosts(blog);
    expect(err).toBeNull();
    expect(report).toEqual([["Delete duplicate", second]]);
    expect(Blog.set).toHaveBeenCalled();
  });

  it("keeps a normalized duplicate when a concurrent change removed the item it duplicates", async function () {
    var nfc = "/caf\u00e9.txt";
    var nfd = "/cafe\u0301.txt";
    var first = { id: nfc, label: "Cafe", url: "/cafe", metadata: {} };
    var second = { id: nfd, label: "Cafe", url: "/cafe", metadata: {} };
    var blog = { id: "blog-id", menu: [first, second] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return new Promise(function (resolve) {
        setTimeout(
          function () {
            resolve({ id: nfc, title: "Cafe", url: "/cafe", metadata: {} });
          },
          id === nfc ? 0 : 5
        );
      });
    });
    // the kept item has been removed by the time we write
    spyOn(Blog, "get").and.callFake(async function (by) {
      return { id: blog.id, menu: [second] };
    });
    spyOn(Blog, "set");

    const { err } = await settle_fixMenuGhosts(blog);
    expect(err).toBeNull();
    expect(Blog.set).not.toHaveBeenCalled();
  });

  it("returns a promise when called without a callback", async function () {
    var item = { id: "/foo", label: "Foo", url: "/foo", metadata: {} };
    var blog = { id: "blog-id", menu: [item] };

    spyOn(Entry, "get").and.callFake(async function () {
      return { id: "/foo", title: "Bar", url: "/foo", metadata: {} };
    });
    spyOn(Blog, "get").and.callFake(async function () {
      return { id: blog.id, menu: [{ id: "/foo", label: "Foo" }] };
    });
    spyOn(Blog, "set").and.callFake(async function () {});

    var report = await fixMenuGhosts(blog);

    expect(report).toEqual([["Changed label of", item]]);
    expect(Blog.set).toHaveBeenCalled();
  });
});
