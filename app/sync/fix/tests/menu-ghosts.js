describe("sync/fix/menu-ghosts", function () {
  var Entry = require("models/entry");
  var Blog = require("models/blog");
  var fixMenuGhosts = require("../menu-ghosts");

  it("does not touch the blog when the menu needs no changes", function (done) {
    var item = { id: "/foo", label: "Foo", url: "/foo", metadata: {} };
    var blog = { id: "blog-id", menu: [item] };

    spyOn(Entry, "get").and.callFake(function (blogID, id, callback) {
      callback({ id: "/foo", title: "Foo", url: "/foo", metadata: {} });
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

    spyOn(Entry, "get").and.callFake(function (blogID, id, callback) {
      callback({ id: "/gone", deleted: true });
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
    var item = { id: "https://example.com", label: "External", url: "https://example.com" };
    var blog = { id: "blog-id", menu: [item] };

    spyOn(Entry, "get").and.callFake(function (blogID, id, callback) {
      callback(undefined);
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

    spyOn(Entry, "get").and.callFake(function (blogID, id, callback) {
      callback({
        id: "/foo",
        title: "New label",
        url: "/new-url",
        metadata: { old: false },
      });
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

    spyOn(Entry, "get").and.callFake(function (blogID, id, callback) {
      callback({ id: "/foo", title: "Foo", url: "/foo", metadata: {} });
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

    spyOn(Entry, "get").and.callFake(function (blogID, id, callback) {
      callback({ id: "/gone", deleted: true });
    });
    spyOn(Blog, "set").and.callFake(function (blogID, updates, callback) {
      callback(setError);
    });

    fixMenuGhosts(blog, function (err) {
      expect(err).toBe(setError);
      done();
    });
  });
});
