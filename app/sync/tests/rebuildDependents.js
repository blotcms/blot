describe("rebuildDependents", function () {
  var rebuildDependents = require("../update/rebuildDependents");
  var Blog = require("models/blog");
  var Entry = require("models/entry");
  var client = require("models/client");

  it("uses sMembers and rejects with redis errors", async function () {
    spyOn(Blog, "get").and.callFake(async function () {
      return { id: "blog-1" };
    });

    spyOn(client, "sMembers").and.returnValue(
      Promise.reject(new Error("redis-fail"))
    );

    let error;

    try {
      await rebuildDependents("blog-1", "/post.md");
    } catch (err) {
      error = err;
    }

    expect(error).toEqual(jasmine.any(Error));
    expect(error.message).toBe("redis-fail");
  });

  it("iterates over dependent paths returned by sMembers", async function () {
    var paths = ["/a.md", "/b.md"];

    spyOn(Blog, "get").and.callFake(async function () {
      return { id: "blog-2" };
    });

    spyOn(client, "sMembers").and.callFake(function (key) {
      return Promise.resolve(
        key.indexOf("template_dependents") > -1 ? [] : paths
      );
    });

    spyOn(Entry, "get").and.callFake(function (_, __) {
      return Promise.resolve(null);
    });

    await rebuildDependents("blog-2", "/post.md");

    expect(client.sMembers).toHaveBeenCalled();
    expect(Entry.get.calls.count()).toBe(paths.length);
  });
});
