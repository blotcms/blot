const fs = require("fs");
const vm = require("vm");

// Loads routes/site.js with its dependencies stubbed and returns the handler
// for POST /webhook/changes.watch/:serviceAccountId. Follow-ups for blogs
// already syncing are covered in clients/util/tests/followUpSync.js; here
// run stands in for followUps.run.
function load({ blogIDs, sync = jasmine.createSpy("sync"), run, lookupError }) {
  let handler;
  let syncBlog;
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
        if (name === "clients/util/followUpSync") {
          return function (followUpName, fn) {
            syncBlog = fn;
            return { run };
          };
        }
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

  function deliver() {
    const res = { sendStatus: jasmine.createSpy("sendStatus") };
    const next = jasmine.createSpy("next");
    handler({ params: { serviceAccountId: "account" } }, res, next);
    return { res, next };
  }

  deliver.syncBlog = (blogID) => syncBlog(blogID);
  return deliver;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("google drive changes.watch webhook", function () {
  it("replies 200 before any sync has finished", async function () {
    const run = jasmine.createSpy("run").and.returnValue(new Promise(() => {}));
    const deliver = load({ blogIDs: ["blog_a"], run });

    const { res } = deliver();
    await flush();

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(run).toHaveBeenCalledWith("blog_a");
  });

  it("passes a blog lookup failure to next instead of replying 200", async function () {
    const run = jasmine.createSpy("run");
    const lookupError = new Error("redis down");
    const deliver = load({ blogIDs: ["blog_a"], run, lookupError });

    const { res, next } = deliver();
    await flush();

    expect(next).toHaveBeenCalledWith(lookupError);
    expect(res.sendStatus).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps blogs isolated when one fails", async function () {
    const run = jasmine.createSpy("run").and.callFake(async (blogID) => {
      if (blogID === "blog_a") throw new Error("boom");
    });
    const deliver = load({ blogIDs: ["blog_a", "blog_b"], run });

    deliver();
    await flush();
    expect(run.calls.allArgs()).toEqual([["blog_a"], ["blog_b"]]);
  });

  it("asks sync to reject when the folder is locked, so a follow-up is queued", async function () {
    const sync = jasmine.createSpy("sync").and.returnValue(Promise.resolve({}));
    const deliver = load({ blogIDs: [], sync, run: jasmine.createSpy("run") });

    await deliver.syncBlog("blog_a");

    expect(sync).toHaveBeenCalledWith("blog_a", { rethrowLocked: true });
  });
});
