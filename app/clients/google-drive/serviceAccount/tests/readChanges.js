describe("google drive readChanges", function () {
  const client = require("models/client");
  const prefix = require("clients/google-drive/database/prefix");
  const database = require("clients/google-drive/database");
  const readChanges = require("../readChanges");

  const SA = "test-sa-read-changes";

  // A fake Drive whose changes.list hands out `pages` in turn, keyed by the
  // page token asked for
  function fakeDrive({ start = "t1", pages = {}, fail = {} } = {}) {
    const drive = {
      asked: [],
      starts: 0,
      changes: {
        getStartPageToken: async () => {
          drive.starts += 1;
          return { data: { startPageToken: start } };
        },
        list: async ({ pageToken }) => {
          drive.asked.push(pageToken);
          if (fail[pageToken]) throw fail[pageToken];
          return { data: pages[pageToken] || { newStartPageToken: pageToken } };
        },
      },
    };
    return drive;
  }

  // Runs the reader until `until()` is true (or 2s pass), then stops it
  async function run(drive, until, onChanges = async () => {}) {
    const controller = new AbortController();
    const running = readChanges(SA, drive, controller.signal, {
      pollMs: 5,
      onChanges,
    });
    const deadline = Date.now() + 2000;
    while (!until() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await running;
  }

  const change = (fileId, parents, extra = {}) => ({
    fileId,
    time: new Date().toISOString(),
    file: { name: fileId + ".md", parents, trashed: false, ...extra },
  });

  beforeEach(async function () {
    spyOn(console, "log");
    spyOn(console, "error");
    await database.blog.store("blog_a", {
      folderId: "folder_a",
      serviceAccountId: SA,
    });
    await database.blog.store("blog_b", {
      folderId: "folder_b",
      serviceAccountId: SA,
    });
    const a = database.folder("folder_a", "blog_a");
    await a.set("folder_a", "/", { isDirectory: true });
    await a.set("dir_a", "/posts", { isDirectory: true });
    await a.set("file_a", "/posts/hello.md");
    const b = database.folder("folder_b", "blog_b");
    await b.set("folder_b", "/", { isDirectory: true });
  });

  afterEach(async function () {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length) await client.del(keys);
  });

  it("starts from a fresh token, then reads from the token Drive gives next", async function () {
    const seen = [];
    const drive = fakeDrive({
      start: "t1",
      pages: {
        t1: { changes: [change("file_a", ["dir_a"])], newStartPageToken: "t2" },
      },
    });

    await run(
      drive,
      () => drive.asked.includes("t2"),
      async (sa, placed) => seen.push(...placed)
    );

    expect(drive.starts).toBe(1);
    expect(await client.get(readChanges.tokenKey(SA))).toBe("t2");
    expect(seen.length).toBe(1);
    expect(seen[0].blogID).toBe("blog_a");
    expect(seen[0].path).toBe("/posts/hello.md");
  });

  it("carries on from the stored token after a restart", async function () {
    await client.set(readChanges.tokenKey(SA), "t5");
    const drive = fakeDrive({ start: "t1" });

    await run(drive, () => drive.asked.length > 0);

    expect(drive.starts).toBe(0);
    expect(drive.asked[0]).toBe("t5");
  });

  it("places a change by the file itself or by its parent, and keeps unplaced ones", async function () {
    const placed = await readChanges.placeChanges(
      [
        { blogID: "blog_a", folderId: "folder_a" },
        { blogID: "blog_b", folderId: "folder_b" },
      ],
      [
        // An edit, rename or trash of a file the blog holds
        change("file_a", ["dir_a"], { name: "renamed.md" }),
        // A new file in a directory the blog holds
        change("new_file", ["dir_a"]),
        // A new file at the top of the other blog's folder
        change("new_root", ["folder_b"]),
        // A file moved out to a folder no blog holds
        change("file_a", ["elsewhere"]),
        // Nothing any blog holds
        change("stranger", ["nowhere"]),
      ]
    );

    const summary = placed.map(({ change, blogID, path, parentPath }) => [
      change.fileId,
      blogID,
      path,
      parentPath,
    ]);
    expect(summary).toEqual([
      ["file_a", "blog_a", "/posts/hello.md", "/posts"],
      ["new_file", "blog_a", null, "/posts"],
      ["new_root", "blog_b", null, "/"],
      ["file_a", "blog_a", "/posts/hello.md", null],
      ["stranger", null, null, null],
    ]);
  });

  it("follows every page of a listing before moving the token on", async function () {
    const seen = [];
    await client.set(readChanges.tokenKey(SA), "p1");
    const drive = fakeDrive({
      pages: {
        p1: { changes: [change("file_a", ["dir_a"])], nextPageToken: "p2" },
        p2: {
          changes: [change("new_file", ["dir_a"])],
          newStartPageToken: "p3",
        },
      },
    });

    await run(
      drive,
      () => drive.asked.includes("p3"),
      async (sa, placed) => seen.push(placed.map((p) => p.change.fileId))
    );

    expect(seen[0]).toEqual(["file_a", "new_file"]);
    expect(await client.get(readChanges.tokenKey(SA))).toBe("p3");
  });

  it("reads a batch again when handling it fails", async function () {
    await client.set(readChanges.tokenKey(SA), "p1");
    const drive = fakeDrive({
      pages: {
        p1: { changes: [change("file_a", ["dir_a"])], newStartPageToken: "p2" },
      },
    });
    let calls = 0;

    await run(
      drive,
      () => calls >= 2,
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("Redis went away");
      }
    );

    expect(drive.asked.slice(0, 2)).toEqual(["p1", "p1"]);
  });

  it("starts again from a fresh token when Drive refuses the stored one", async function () {
    await client.set(readChanges.tokenKey(SA), "stale");
    const refused = Object.assign(new Error("Invalid page token"), {
      code: 404,
    });
    const drive = fakeDrive({ start: "fresh", fail: { stale: refused } });

    await run(drive, () => drive.asked.includes("fresh"));

    expect(drive.starts).toBe(1);
    expect(drive.asked.slice(0, 2)).toEqual(["stale", "fresh"]);
  });

  it("stops promptly when the signal aborts", async function () {
    const controller = new AbortController();
    const drive = fakeDrive();
    const running = readChanges(SA, drive, controller.signal, {
      pollMs: 60000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    const stopped = await Promise.race([
      running.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    expect(stopped).toBe(true);
  });
});
