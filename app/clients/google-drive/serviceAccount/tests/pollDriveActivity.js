// pollDriveActivity runs under a lease (init.js): it must wind down promptly
// when the lease is lost or the process drains, not carry on after another
// process has taken over.
describe("google drive pollDriveActivity", function () {
  const database = require("clients/google-drive/database");
  const pollDriveActivity = require("../pollDriveActivity");

  const finishedWithin = (promise, ms) =>
    Promise.race([
      promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), ms)),
    ]);

  let iterations;

  beforeEach(function () {
    iterations = 0;
    spyOn(console, "log");
    spyOn(database.blog, "iterateByServiceAccountId").and.callFake(async () => {
      iterations++;
    });
  });

  it("stops during its pause between rounds when the signal aborts", async function () {
    const controller = new AbortController();
    const running = pollDriveActivity("test-sa", {}, controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(iterations).toEqual(1);

    controller.abort();

    // The pause between rounds is 5 seconds
    expect(await finishedWithin(running, 1000)).toEqual(true);
    expect(iterations).toEqual(1);
  });

  it("does nothing when the signal is already aborted", async function () {
    const controller = new AbortController();
    controller.abort();

    await pollDriveActivity("test-sa", {}, controller.signal);

    expect(iterations).toEqual(0);
  });

  describe("on new activity", function () {
    const followUps = require("clients/google-drive/sync/followUps");
    let order;

    // One round over one blog whose last stored activity is `stored`, with
    // Drive reporting activity at `latest`
    async function round(stored, latest) {
      order = [];
      const controller = new AbortController();
      database.blog.iterateByServiceAccountId.and.callFake(
        async (sa, callback) => {
          await callback("blog_a", {
            folderId: "folder",
            latestDriveActivityTimestamp: stored,
          });
          controller.abort();
        }
      );
      spyOn(database.blog, "update").and.callFake(async (blogID, changes) => {
        order.push(["stored", changes.latestDriveActivityTimestamp]);
      });
      spyOn(followUps, "arm").and.callFake(async (blogID) => {
        order.push(["armed", blogID]);
        return 123;
      });
      spyOn(followUps, "run").and.callFake(async (blogID, armed) => {
        order.push(["ran", blogID, armed]);
      });
      const driveactivity = {
        activity: {
          query: async () => ({
            data: { activities: [{ timestamp: latest }] },
          }),
        },
      };

      await pollDriveActivity("test-sa", driveactivity, controller.signal);
      await new Promise((resolve) => setImmediate(resolve));
      return order;
    }

    it("arms a follow-up, stores the timestamp, then syncs through the follow-up queue", async function () {
      expect(await round("t1", "t2")).toEqual([
        ["armed", "blog_a"],
        ["stored", "t2"],
        ["ran", "blog_a", 123],
      ]);
    });

    it("only stores the timestamp the first time it sees a blog's activity", async function () {
      expect(await round(undefined, "t1")).toEqual([["stored", "t1"]]);
    });

    it("does nothing when the activity is the one it stored", async function () {
      expect(await round("t1", "t1")).toEqual([]);
    });
  });
});
