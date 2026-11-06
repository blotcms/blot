describe("redirects (promise form)", function () {
  const Redirects = require("models/redirects");

  global.test.blog();

  it("sets, lists, checks and drops without a callback", async function () {
    const id = this.blog.id;

    await Redirects.set(id, [{ from: "/a", to: "/b" }]);

    expect(await Redirects.list(id)).toEqual([
      { from: "/a", to: "/b", index: 0 },
    ]);
    expect(await Redirects.check(id, "/a")).toEqual("/b");

    await Redirects.drop(id, "/a");

    expect(await Redirects.list(id)).toEqual([]);
    expect(await Redirects.check(id, "/a")).toBeFalsy();
  });

  it("rejects instead of throwing when an argument is invalid", async function () {
    await expectAsync(Redirects.list(123)).toBeRejected();
  });

  it("returns conflicts without a callback", async function () {
    const results = await Redirects.conflicts(this.blog, [
      { from: "/search", to: "/x" },
    ]);

    expect(results[0].type).toEqual("route");
  });
});
