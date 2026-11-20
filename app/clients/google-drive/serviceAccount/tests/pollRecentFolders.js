const fs = require("fs");
const vm = require("vm");

describe("google drive pollRecentFolders", function () {
  const FOLDER = "application/vnd.google-apps.folder";

  // Loads the poller with database.recent.list stubbed by list
  function load(list) {
    const stubs = {
      "helper/clfdate": () => "[date]",
      "../database": { recent: { list } },
      "../sync/util/driveReaddir": null,
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

    // One round, then the ten second pause
    expect(lists).toBe(1);
  });
});
