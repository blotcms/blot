const fs = require("fs");
const vm = require("vm");

// Loads routes/site.js with its dependencies stubbed and returns the handler
// for POST /webhook/changes.watch/:serviceAccountId
function load({ blogIDs, sync, lookupError }) {
  let handler;
  const route = {
    post: function (fn) {
      handler = fn;
      return route;
    },
  };
  const router = { route: () => route };
  const module = { exports: {} };

  vm.runInNewContext(
    fs.readFileSync(require.resolve("../routes/site"), "utf8"),
    {
      module,
      exports: module.exports,
      console: { log: function () {}, error: function () {} },
      require: function (name) {
        if (name === "config") return {};
        if (name === "helper/clfdate") return () => "[date]";
        if (name === "express") return { Router: function () { return router; } };
        if (name === "clients/google-drive/sync") return sync;
        if (name === "clients/google-drive/database") {
          return {
            blog: {
              iterateByServiceAccountId: async function (id, fn) {
                if (lookupError) throw lookupError;
                for (const blogID of blogIDs) await fn(blogID, {});
              },
            },
          };
        }
        return require(name);
      },
    }
  );

  return function deliver() {
    const res = { sendStatus: jasmine.createSpy("sendStatus") };
    const next = jasmine.createSpy("next");
    handler({ params: { serviceAccountId: "account" } }, res, next);
    return { res, next };
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("google drive changes.watch webhook", function () {
  it("replies 200 before any sync has finished", async function () {
    const sync = jasmine.createSpy("sync").and.returnValue(new Promise(() => {}));
    const deliver = load({ blogIDs: ["blog_a"], sync });

    const { res } = deliver();
    await flush();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(sync).toHaveBeenCalledWith("blog_a");
  });

  it("passes a blog lookup failure to next instead of replying 200", async function () {
    const sync = jasmine.createSpy("sync");
    const lookupError = new Error("redis down");
    const deliver = load({ blogIDs: ["blog_a"], sync, lookupError });

    const { res, next } = deliver();
    await flush();

    expect(next).toHaveBeenCalledWith(lookupError);
    expect(res.sendStatus).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("collapses deliveries during a sync into one follow-up sync", async function () {
    const releases = [];
    const sync = jasmine.createSpy("sync").and.callFake(
      () => new Promise((resolve) => releases.push(resolve))
    );
    const deliver = load({ blogIDs: ["blog_a"], sync });

    deliver();
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);

    deliver();
    deliver();
    deliver();
    await flush();
    // No second concurrent sync was started
    expect(sync).toHaveBeenCalledTimes(1);

    releases[0]();
    await flush();
    // Exactly one follow-up sync, however many deliveries arrived
    expect(sync).toHaveBeenCalledTimes(2);

    releases[1]();
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);

    // Nothing is left pending or marked as ongoing
    deliver();
    await flush();
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it("keeps blogs isolated and clears the ongoing marker on failure", async function () {
    const sync = jasmine.createSpy("sync").and.callFake(async (blogID) => {
      if (blogID === "blog_a") throw new Error("boom");
    });
    const deliver = load({ blogIDs: ["blog_a", "blog_b"], sync });

    deliver();
    await flush();
    expect(sync.calls.allArgs()).toEqual([["blog_a"], ["blog_b"]]);

    // blog_a failed but can be synced by the next delivery
    deliver();
    await flush();
    expect(sync).toHaveBeenCalledTimes(4);
  });
});
