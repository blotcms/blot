describe("rebuildDependents", function () {
  var rebuildDependents = require("../update/rebuildDependents");
  var Blog = require("models/blog");
  var Entry = require("models/entry");
  var client = require("models/client");

  it("uses sMembers and routes redis rejections to callback", function (done) {
    spyOn(Blog, "get").and.callFake(function (_, callback) {
      callback(null, { id: "blog-1" });
    });

    spyOn(client, "sMembers").and.returnValue(
      Promise.reject(new Error("redis-fail"))
    );

    rebuildDependents("blog-1", "/post.md", function (err) {
      expect(err).toEqual(jasmine.any(Error));
      expect(err.message).toBe("redis-fail");
      done();
    });
  });

  it("iterates over dependent paths returned by sMembers", function (done) {
    var paths = ["/a.md", "/b.md"];

    spyOn(Blog, "get").and.callFake(function (_, callback) {
      callback(null, { id: "blog-2" });
    });

    spyOn(client, "sMembers").and.callFake(function (key) {
      return Promise.resolve(key.indexOf("template_dependents") > -1 ? [] : paths);
    });

    spyOn(Entry, "get").and.callFake(function (_, __, callback) {
      callback(null);
    });

    rebuildDependents("blog-2", "/post.md", function (err) {
      expect(err).toBeFalsy();
      expect(client.sMembers).toHaveBeenCalled();
      expect(Entry.get.calls.count()).toBe(paths.length);
      done();
    });
  });
});
