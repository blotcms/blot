const fs = require("fs");
const vm = require("vm");

describe("google drive syncChanges", function () {
  const DOCUMENT = "application/vnd.google-apps.document";

  // Loads syncChanges.js with its collaborators stubbed
  function load({ run = async () => {} } = {}) {
    const calls = [];
    const sources = [];
    const touched = [];
    const prefetched = [];
    const stubs = {
      "helper/clfdate": () => "[date]",
      "../database": {
        dirty: {
          FULL: "*",
          add: async (blogID, ids, source) => {
            calls.push("dirty " + blogID + " " + ids.join(","));
            sources.push(source);
          },
          hintMoves: async (blogID, moves) => {
            calls.push(
              "moves " +
                blogID +
                " " +
                moves.map((m) => m.id + ">" + m.parentId).join(",")
            );
          },
        },
        recent: {
          touch: async (sa, blogID, ids) =>
            touched.push(blogID + " " + ids.join(",")),
        },
        blog: {
          get: async (blogID) => ({ folderId: "folder-" + blogID }),
        },
        folder: () => ({
          getByPath: async (path) =>
            ({ "/": "root", "/posts": "posts" })[path] || null,
          get: async (id) => ({ posts: "/posts" })[id] || null,
        }),
      },
      "../sync/followUps": {
        arm: async (blogID) => {
          calls.push("arm " + blogID);
          return "token-" + blogID;
        },
        run: (blogID, armed) => {
          calls.push("run " + blogID + " " + armed);
          return run(blogID);
        },
      },
      "./hotDocPoller": {
        enqueue: async ({ blogID, fileId }) => {
          calls.push("enqueue " + blogID + " " + fileId);
        },
      },
      "./readChanges": { logChanges: () => {} },
      "./createDriveClient": async () => "drive",
      "../util/prefetch": {
        start: (drive, file) => prefetched.push(file.id),
      },
    };
    const module = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(require.resolve("../syncChanges"), "utf8"),
      {
        module,
        exports: module.exports,
        console: { log() {}, error() {} },
        require: (name) => (name in stubs ? stubs[name] : require(name)),
      }
    );
    return { syncChanges: module.exports, calls, sources, touched, prefetched };
  }

  const entry = (blogID, fileId, file = {}, place = {}) => ({
    blogID,
    folderId: blogID && "folder-" + blogID,
    change: { fileId, file: { mimeType: "text/plain", ...file } },
    path: null,
    parentId: "posts",
    ...place,
  });

  it("arms a follow-up for each blog before syncing any, then syncs each blog once", async function () {
    const { syncChanges, calls } = load();

    await syncChanges("sa", [
      entry("blog_a", "1"),
      entry("blog_a", "2"),
      entry("blog_b", "3"),
    ]);

    expect(calls).toEqual([
      "dirty blog_a posts",
      "dirty blog_b posts",
      "arm blog_a",
      "arm blog_b",
      "run blog_a token-blog_a",
      "run blog_b token-blog_b",
    ]);
  });

  it("marks the directory a file was in and the one it is in now", async function () {
    const { syncChanges, calls } = load();

    await syncChanges("sa", [
      // Moved from /posts to the top of the folder
      entry("blog_a", "1", {}, { path: "/posts/a.md", parentId: "root" }),
      // A file whose directory the mapping lost asks for a full walk
      entry("blog_b", "2", {}, { path: "/lost/b.md", parentId: null }),
      // The blog's own folder changed: listed again, not a full walk
      entry("blog_c", "folder-blog_c", {}, { path: "/", parentId: null }),
    ]);

    expect(calls).toContain("dirty blog_a posts,root");
    expect(calls).toContain("dirty blog_b *");
    expect(calls).toContain("dirty blog_c folder-blog_c");
  });

  it("hints where a folder the blog holds has moved to, but not a file, a trashed folder or a move out", async function () {
    const FOLDER = "application/vnd.google-apps.folder";
    const { syncChanges, calls } = load();

    await syncChanges("sa", [
      entry(
        "blog_a",
        "F",
        { mimeType: FOLDER },
        { path: "/posts/f", parentId: "root" }
      ),
      entry(
        "blog_a",
        "G",
        { mimeType: FOLDER, trashed: true },
        { path: "/g", parentId: "root" }
      ),
      entry(
        "blog_a",
        "H",
        { mimeType: FOLDER },
        { path: "/h", parentId: null }
      ),
      entry("blog_a", "file", {}, { path: "/posts/a.md", parentId: "root" }),
    ]);

    expect(calls.filter((c) => c.startsWith("moves"))).toEqual([
      "moves blog_a F>root",
    ]);
  });

  it("ignores changes no blog holds", async function () {
    const { syncChanges, calls } = load();

    await syncChanges("sa", [entry(null, "1")]);

    expect(calls).toEqual([]);
  });

  it("hands changed Google Docs to the hot doc poller, but not trashed ones", async function () {
    const { syncChanges, calls } = load();

    await syncChanges("sa", [
      entry("blog_a", "doc", { mimeType: DOCUMENT }),
      entry("blog_a", "gone", { mimeType: DOCUMENT, trashed: true }),
      entry("blog_a", "text"),
    ]);

    expect(calls).toContain("enqueue blog_a doc");
    expect(calls).not.toContain("enqueue blog_a gone");
    expect(calls).not.toContain("enqueue blog_a text");
  });

  it("doesn't wait for the syncs, and survives one failing", async function () {
    const { syncChanges } = load({
      run: (blogID) =>
        blogID === "blog_a"
          ? new Promise(() => {})
          : Promise.reject(new Error("boom")),
    });

    const finished = await Promise.race([
      syncChanges("sa", [entry("blog_a", "1"), entry("blog_b", "2")]).then(
        () => true
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);

    expect(finished).toBe(true);
  });

  it("lists the directories it marks for the next few minutes, recording the source", async function () {
    const { syncChanges, sources, touched } = load();

    await syncChanges("sa", [entry("blog_a", "1")], "search");

    expect(sources).toEqual(["search"]);
    expect(touched).toEqual(["blog_a posts"]);
  });

  it("syncs the blogs whose recent folders listed differently, keeping new folders in them recent", async function () {
    const { syncChanges, calls, sources, touched } = load();

    await syncChanges.syncDirectories("sa", [
      { blogID: "blog_a", dirId: "posts", folders: ["sub"] },
    ]);

    expect(sources).toEqual(["recent"]);
    expect(touched).toEqual(["blog_a posts,sub"]);
    expect(calls).toEqual([
      "dirty blog_a posts",
      "arm blog_a",
      "run blog_a token-blog_a",
    ]);
  });

  it("starts downloading changed files with a checksum, but not Docs, folders or trashed files", async function () {
    const { syncChanges, prefetched } = load();

    await syncChanges("sa", [
      entry("blog_a", "file", { md5Checksum: "m", size: "5" }),
      entry("blog_a", "doc", { mimeType: DOCUMENT }),
      entry("blog_a", "gone", { md5Checksum: "m", trashed: true }),
      entry("blog_a", "nosum"),
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(prefetched).toEqual(["file"]);
  });
});
