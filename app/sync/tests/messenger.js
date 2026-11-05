describe("sync messenger", function () {
  const Blog = require("models/blog");
  const client = require("models/client");
  const messenger = require("../messenger");

  it("logs a failed status write instead of dropping it", function () {
    spyOn(console, "log");
    spyOn(client, "publish").and.returnValue(Promise.resolve(1));
    spyOn(Blog, "setStatus").and.callFake(function (blogID, status, callback) {
      callback(new Error("redis down"));
    });

    messenger({ id: "blog_0123456789abcdef" }).status("Syncing");

    const lines = console.log.calls.allArgs().map((args) => args.join(" "));
    expect(
      lines.some((l) => l.includes("failed to store sync status redis down"))
    ).toBe(true);
  });
});
