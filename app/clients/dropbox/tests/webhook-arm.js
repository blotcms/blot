describe("dropbox webhook follow-ups", function () {
  const Database = require("clients/dropbox/database");
  const site = require("clients/dropbox/routes/site");
  const { followUps } = site;

  let events;

  beforeEach(function () {
    events = [];
    spyOn(Database, "listBlogs").and.callFake(async (account_id) =>
      account_id === "dbid:a" ? [{ id: "blog_a1" }, { id: "blog_a2" }] : []
    );
    spyOn(followUps, "run").and.callFake(async (blogID, armed) => {
      events.push(["run", blogID, armed]);
    });
  });

  it("arms every blog's follow-up before it lets the webhook answer", async function () {
    spyOn(followUps, "arm").and.callFake(async (blogID) => {
      events.push(["arm", blogID]);
      return "token-" + blogID;
    });

    const { synced } = await site.handleWebhook(["dbid:a", "dbid:b"]);
    await synced;

    // The syncs may start as soon as arming is done, so compare the order
    const kinds = events.map((e) => e[0]);
    expect(kinds).toEqual(["arm", "arm", "run", "run"]);
    expect(events.filter((e) => e[0] === "run").sort()).toEqual([
      ["run", "blog_a1", "token-blog_a1"],
      ["run", "blog_a2", "token-blog_a2"],
    ]);
  });

  it("still syncs a blog whose follow-up couldn't be armed", async function () {
    spyOn(followUps, "arm").and.callFake(async (blogID) => {
      if (blogID === "blog_a1") throw new Error("Redis is down");
      return "token-" + blogID;
    });

    const { synced } = await site.handleWebhook(["dbid:a"]);
    await synced;
    expect(events.sort()).toEqual([
      ["run", "blog_a1", undefined],
      ["run", "blog_a2", "token-blog_a2"],
    ]);
  });
});
