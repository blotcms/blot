describe("logContext", function () {
  const logContext = require("helper/logContext");
  const { format } = require("helper/oneLineConsole");

  it("has no fields outside a context, and set does nothing there", function () {
    logContext.set({ blog: "blog_outside" });
    expect(logContext.fields()).toEqual([]);
  });

  it("keeps its fields across awaits, in a fixed order", async function () {
    await logContext.run({ req: "r1" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      logContext.set({ sync: "sync_1", blog: "blog_1" });
      await null;
      expect(logContext.fields()).toEqual([
        ["req", "r1"],
        ["blog", "blog_1"],
        ["sync", "sync_1"],
      ]);
    });
  });

  it("adds a nested context's fields to the caller's, without changing them", async function () {
    await logContext.run({ req: "r1", blog: "blog_a" }, async () => {
      await logContext.run({ blog: "blog_b" }, async () => {
        logContext.set({ sync: "sync_2" });
        expect(logContext.fields()).toEqual([
          ["req", "r1"],
          ["blog", "blog_b"],
          ["sync", "sync_2"],
        ]);
      });
      expect(logContext.fields()).toEqual([
        ["req", "r1"],
        ["blog", "blog_a"],
      ]);
    });
  });

  it("keeps two concurrent requests apart", async function () {
    const seen = [];
    const request = (id, delay) =>
      logContext.run({ req: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        seen.push(format("done"));
      });

    await Promise.all([request("r1", 5), request("r2", 1)]);
    expect(seen).toEqual(["done req=r2", "done req=r1"]);
  });

  it("ends a console line with the fields the line doesn't already have", function () {
    const blogID = "blog_0123456789abcdef";
    logContext.run({ req: "abc123", blog: blogID }, () => {
      expect(format("Building", "/a.txt")).toBe(
        `Building /a.txt req=abc123 blog=${blogID}`
      );
      // The request logger's lines carry the request id, the sync logger's
      // the first 12 characters of the blog id
      expect(format("[date] abc123 200 0.010 https://x/")).toBe(
        `[date] abc123 200 0.010 https://x/ blog=${blogID}`
      );
      expect(format(blogID.slice(0, 12), "sync_1", "Synced")).toBe(
        `${blogID.slice(0, 12)} sync_1 Synced req=abc123`
      );
    });
  });

  it("leaves a line outside a context alone", function () {
    expect(format("Server listening")).toBe("Server listening");
  });
});
