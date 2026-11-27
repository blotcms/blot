const fs = require("fs");
const vm = require("vm");

describe("google drive pollRecentFolders", function () {
  const FOLDER = "application/vnd.google-apps.folder";

  // Loads the poller with database.recent.list stubbed by list
  function load(list) {
    const stubs = {
      "helper/clfdate": () => "[date]",
      "./rateLimit": require("../rateLimit"),
      "../database": { recent: { list } },
      "../sync/util/driveReaddir": null,
      "../util/prefetch": { start() {} },
    };
    const module = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(require.resolve("../pollRecentFolders"), "utf8"),
      {
        module,
        exports: module.exports,
        console: { log() {}, error() {} },
        setTimeout,
        clearTimeout,
        AbortController,
        require: (name) => (name in stubs ? stubs[name] : require(name)),
      }
    );
    return module.exports;
  }

  it("notes the first listing, then reports a directory whose listing changed", async function () {
    const file = { id: "a", name: "a.md", mimeType: "text/plain" };
    const sub = { id: "sub", name: "sub", mimeType: FOLDER };
    const rounds = [
      { posts: [file] },
      { posts: [file] },
      { posts: [file, sub] },
    ];
    let round = 0;
    const controller = new AbortController();
    const changed = [];

    const poll = load(async () => {
      if (round >= rounds.length) {
        controller.abort();
        return [];
      }
      return [{ blogID: "blog_a", dirId: "posts" }];
    });

    await poll("sa", {}, controller.signal, {
      everyMs: 1,
      readdir: async (drive, dirId) => (rounds[round++] || {})[dirId] || [],
      onChanged: async (sa, list) => changed.push(...list),
    });

    expect(changed).toEqual([
      { blogID: "blog_a", dirId: "posts", folders: ["sub"] },
    ]);
  });

  it("tells a listing apart by name, checksum and modified time, not order", function () {
    const { fingerprint } = load(async () => []);
    const a = { id: "a", name: "a.md", md5Checksum: "1", modifiedTime: "t" };
    const b = { id: "b", name: "b.md", md5Checksum: "2", modifiedTime: "t" };

    expect(fingerprint([a, b])).toBe(fingerprint([b, a]));
    expect(fingerprint([a])).not.toBe(fingerprint([{ ...a, name: "c.md" }]));
    expect(fingerprint([a])).not.toBe(
      fingerprint([{ ...a, md5Checksum: "3" }])
    );
    expect(fingerprint([a])).not.toBe(
      fingerprint([{ ...a, modifiedTime: "u" }])
    );
  });

  it("backs off when Drive rate-limits a listing", async function () {
    const controller = new AbortController();
    let lists = 0;
    const poll = load(async () => {
      lists += 1;
      return [{ blogID: "blog_a", dirId: "posts" }];
    });

    const running = poll("sa", {}, controller.signal, {
      everyMs: 1,
      readdir: async () => {
        throw Object.assign(new Error("Rate limit"), { code: 429 });
      },
      onChanged: async () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await running;

    // One round, then the backoff's pause (at least five seconds)
    expect(lists).toBe(1);
  });

  it("paces its rounds by every files.list call, pages included", async function () {
    const controller = new AbortController();
    const rounds = [];
    const poll = load(async () => {
      rounds.push(Date.now());
      if (rounds.length > 1) {
        controller.abort();
        return [];
      }
      return [{ blogID: "blog_a", dirId: "big" }];
    });

    // One directory that takes 24 pages to list: 1.5s of the budget
    let calls = 0;
    const drive = {
      files: {
        list: async () => {
          calls += 1;
          return { data: { files: [] } };
        },
      },
    };
    await poll("sa", drive, controller.signal, {
      everyMs: 1,
      readdir: async (counted) => {
        for (let i = 0; i < 24; i++) await counted.files.list({});
        return [];
      },
      onChanged: async () => {},
    });

    expect(calls).toBe(24);
    expect(rounds[1] - rounds[0]).toBeGreaterThanOrEqual(1400);
  });

  it("never changes the Drive client it was given", async function () {
    const controller = new AbortController();
    let rounds = 0;
    const poll = load(async () => {
      if (++rounds > 1) {
        controller.abort();
        return [];
      }
      return [{ blogID: "blog_a", dirId: "posts" }];
    });

    // Like googleapis: files can't be replaced, and list is on a prototype
    class Files {
      async list() {
        return { data: { files: [] } };
      }
    }
    const drive = {};
    Object.defineProperty(drive, "files", { value: new Files() });
    const list = drive.files.list;

    await poll("sa", drive, controller.signal, {
      everyMs: 1,
      readdir: async (counted) => counted.files.list({}),
      onChanged: async () => {},
    });

    expect(drive.files.list).toBe(list);
    expect(Object.keys(drive.files)).toEqual([]);
    expect(await drive.files.list()).toEqual({ data: { files: [] } });
  });

  it("gives up on a listing that hangs, and lists again next round", async function () {
    const controller = new AbortController();
    let round = 0;
    const file = { id: "a", name: "a.md", mimeType: "text/plain" };
    const changed = [];
    const poll = load(async () => {
      if (++round > 4) {
        controller.abort();
        return [];
      }
      return [{ blogID: "blog_a", dirId: "posts" }];
    });

    await poll("sa", {}, controller.signal, {
      everyMs: 1,
      listingTimeoutMs: 20,
      // The second listing never answers; the third and fourth differ
      readdir: async () =>
        round === 2
          ? new Promise(() => {})
          : round === 4
            ? [file, { ...file, id: "b", name: "b.md" }]
            : [file],
      onChanged: async (sa, list) => changed.push(...list),
    });

    expect(round).toBe(5);
    expect(changed.length).toBe(1);
  });

  it("cancels the request of a listing that hangs", async function () {
    const controller = new AbortController();
    let round = 0;
    const signals = [];
    const poll = load(async () => {
      if (++round > 1) {
        controller.abort();
        return [];
      }
      return [{ blogID: "blog_a", dirId: "posts" }];
    });
    // Like googleapis: rejects once the request's signal aborts
    const drive = {
      files: {
        list: (params, { signal }) =>
          new Promise((resolve, reject) => {
            signals.push(signal);
            signal.addEventListener("abort", () =>
              reject(new Error("The operation was aborted"))
            );
          }),
      },
    };

    await poll("sa", drive, controller.signal, {
      everyMs: 1,
      listingTimeoutMs: 20,
      readdir: async (client) => client.files.list({}),
      onChanged: async () => {},
    });

    expect(signals.length).toBe(1);
    expect(signals[0].aborted).toBe(true);
  });

  it("starts downloading the files whose bytes changed", async function () {
    const controller = new AbortController();
    let round = 0;
    const started = [];
    const poll = load(async () => {
      if (++round > 2) {
        controller.abort();
        return [];
      }
      return [{ blogID: "blog_a", dirId: "posts" }];
    });
    const a = {
      id: "a",
      name: "a.md",
      mimeType: "text/plain",
      md5Checksum: "1",
      size: "3",
    };
    const b = {
      id: "b",
      name: "b.md",
      mimeType: "text/plain",
      md5Checksum: "2",
      size: "4",
    };
    const doc = {
      id: "d",
      name: "d.gdoc",
      mimeType: "application/vnd.google-apps.document",
    };
    const drive = {};

    await poll("sa", drive, controller.signal, {
      everyMs: 1,
      // Second round: a renamed, b edited, a Doc added
      readdir: async () =>
        round === 1
          ? [a, b]
          : [{ ...a, name: "A.md" }, { ...b, md5Checksum: "5" }, doc],
      onChanged: async () => {},
      prefetch: { start: (client, file) => started.push([client, file]) },
    });

    expect(started).toEqual([
      [drive, { id: "b", md5Checksum: "5", size: "4" }],
    ]);
  });
});
