describe("sync/fix/menu-ghosts", function () {
  var Entry = require("models/entry");
  var Blog = require("models/blog");
  var fixMenuGhosts = require("../menu-ghosts");

  it("does not touch the blog when the menu needs no changes", function (done) {
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

    fixMenuGhosts(blog, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([]);
      expect(Blog.set).not.toHaveBeenCalled();
      done();
    });
  });

  it("removes a menu item whose entry has been deleted", function (done) {
    var item = { id: "/gone", label: "Gone", url: "/gone", metadata: {} };
    var blog = { id: "blog-id", menu: [item] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return Promise.resolve({ id: "/gone", deleted: true });
    });
    // what is stored, before Fix() edits blog.menu in place
    var stored = JSON.parse(JSON.stringify(blog.menu));
    spyOn(Blog, "get").and.callFake(function (by, callback) {
      callback(null, { id: blog.id, menu: stored });
    });
    spyOn(Blog, "set").and.callFake(function (blogID, updates, callback) {
      expect(updates.menu).toEqual([]);
      callback(null);
    });

    fixMenuGhosts(blog, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([["Delete", item]]);
      expect(Blog.set).toHaveBeenCalled();
      done();
    });
  });

  it("keeps a menu item whose id does not correspond to any entry", function (done) {
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

    fixMenuGhosts(blog, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([]);
      expect(Blog.set).not.toHaveBeenCalled();
      done();
    });
  });

  it("updates a menu item's label, metadata and url to match its entry", function (done) {
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
    spyOn(Blog, "get").and.callFake(function (by, callback) {
      callback(null, { id: blog.id, menu: stored });
    });
    spyOn(Blog, "set").and.callFake(function (blogID, updates, callback) {
      expect(updates.menu).toEqual([
        {
          id: "/foo",
          label: "New label",
          url: "/new-url",
          metadata: { old: false },
        },
      ]);
      callback(null);
    });

    fixMenuGhosts(blog, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([
        ["Changed label of", item],
        ["Changed metadata of", item],
        ["Changed URL of", item],
      ]);
      expect(Blog.set).toHaveBeenCalled();
      done();
    });
  });

  it("removes a menu item that duplicates an entry already kept in the menu", function (done) {
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
    spyOn(Blog, "get").and.callFake(function (by, callback) {
      callback(null, { id: blog.id, menu: stored });
    });
    spyOn(Blog, "set").and.callFake(function (blogID, updates, callback) {
      expect(updates.menu).toEqual([first]);
      callback(null);
    });

    fixMenuGhosts(blog, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([["Delete duplicate", second]]);
      expect(Blog.set).toHaveBeenCalled();
      done();
    });
  });

  it("propagates an error from Blog.set", function (done) {
    var setError = new Error("set exploded");
    var item = { id: "/gone", label: "Gone", url: "/gone", metadata: {} };
    var blog = { id: "blog-id", menu: [item] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return Promise.resolve({ id: "/gone", deleted: true });
    });
    // what is stored, before Fix() edits blog.menu in place
    var stored = JSON.parse(JSON.stringify(blog.menu));
    spyOn(Blog, "get").and.callFake(function (by, callback) {
      callback(null, { id: blog.id, menu: stored });
    });
    spyOn(Blog, "set").and.callFake(function (blogID, updates, callback) {
      callback(setError);
    });

    fixMenuGhosts(blog, function (err) {
      expect(err).toBe(setError);
      done();
    });
  });

  it("keeps a menu item added by a concurrent sync after the menu was read", function (done) {
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
    spyOn(Blog, "get").and.callFake(function (by, callback) {
      callback(null, { id: blog.id, menu: [ghost, kept, added] });
    });
    spyOn(Blog, "set").and.callFake(function (blogID, updates, callback) {
      expect(updates.menu).toEqual([kept, added]);
      callback(null);
    });

    fixMenuGhosts(blog, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([["Delete", ghost]]);
      expect(Blog.set).toHaveBeenCalled();
      done();
    });
  });

  it("does not write when a concurrent change already removed the ghost", function (done) {
    var ghost = { id: "/gone", label: "Gone", url: "/gone", metadata: {} };
    var blog = { id: "blog-id", menu: [ghost] };

    spyOn(Entry, "get").and.callFake(function (blogID, id) {
      return Promise.resolve({ id: "/gone", deleted: true });
    });
    spyOn(Blog, "get").and.callFake(function (by, callback) {
      callback(null, { id: blog.id, menu: [] });
    });
    spyOn(Blog, "set");

    fixMenuGhosts(blog, function (err) {
      expect(err).toBeNull();
      expect(Blog.set).not.toHaveBeenCalled();
      done();
    });
  });

  it("removes a duplicate whose raw id differs but normalizes to the same entry", function (done) {
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
    spyOn(Blog, "get").and.callFake(function (by, callback) {
      callback(null, { id: blog.id, menu: stored });
    });
    spyOn(Blog, "set").and.callFake(function (blogID, updates, callback) {
      expect(updates.menu).toEqual([first]);
      callback(null);
    });

    fixMenuGhosts(blog, function (err, report) {
      expect(err).toBeNull();
      expect(report).toEqual([["Delete duplicate", second]]);
      expect(Blog.set).toHaveBeenCalled();
      done();
    });
  });

  it("keeps a normalized duplicate when a concurrent change removed the item it duplicates", function (done) {
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
    spyOn(Blog, "get").and.callFake(function (by, callback) {
      callback(null, { id: blog.id, menu: [second] });
    });
    spyOn(Blog, "set");

    fixMenuGhosts(blog, function (err) {
      expect(err).toBeNull();
      expect(Blog.set).not.toHaveBeenCalled();
      done();
    });
  });
});
