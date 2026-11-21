describe("google drive recent directories", function () {
  const client = require("models/client");
  const recent = require("clients/google-drive/database/recent");

  const SA = "sa_recent_test";

  afterEach(async function () {
    await client.del(recent.key(SA));
  });

  it("lists the most recently changed directories first", async function () {
    await recent.touch(SA, "blog_a", ["old"], 1000);
    await recent.touch(SA, "blog_a", ["new"], 2000);
    await recent.touch(SA, "blog_b", ["other"], 1500);

    const list = await recent.list(SA, 2, 2500);
    expect(list.map(({ blogID, dirId }) => blogID + " " + dirId)).toEqual([
      "blog_a new",
      "blog_b other",
    ]);
  });

  it("forgets directories quiet for longer than the window", async function () {
    const now = Date.now();
    await recent.touch(SA, "blog_a", ["quiet"], now - recent.WINDOW_MS - 1);
    await recent.touch(SA, "blog_a", ["busy"], now);

    const list = await recent.list(SA, 10, now);
    expect(list.map(({ dirId }) => dirId)).toEqual(["busy"]);
  });

  it("ignores the full walk marker", async function () {
    await recent.touch(SA, "blog_a", ["*"]);

    expect(await recent.list(SA, 10)).toEqual([]);
  });
});
