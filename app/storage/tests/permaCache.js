describe("storage/sweep/permaCache", function () {
  global.test.blog();

  const config = require("config");
  const bunnyStorage = require("helper/bunnyStorage");
  const assets = require("storage/assets");
  const folder = require("storage/folder");
  const contentVersion = require("helper/contentVersion");
  const permaCache = require("storage/sweep/permaCache");
  const client = require("models/client");
  const crypto = require("crypto");
  const fs = require("fs-extra");
  const templateKey = require("models/template/key");
  const documentationURL = require("documentation/tools/cdn-url-helper");
  const { GLOBAL_STATIC_DIR } = require("blog/lib/staticPaths");

  const noGenerated = () => (async function* () {})();

  const ROOT = "__bcdn_perma_cache__/";
  const BASE = ROOT + "pullzone__" + config.bunny.pull_zone + "__1/";

  let removed;

  // A storage zone holding a cached response for each URL path, laid out as
  // Perma-Cache lays it out: a directory per segment, the last ___<name>___
  function zone(paths) {
    const dirs = {
      [ROOT]: [
        {
          name: "pullzone__" + config.bunny.pull_zone + "__1",
          isDirectory: true,
        },
      ],
    };

    for (const spec of paths) {
      const path = typeof spec === "string" ? spec : spec.path;
      const files =
        typeof spec === "string" ? [{}] : spec.files || [spec.file || {}];
      const segments = path.slice(1).split("/");
      let dir = BASE;

      segments.forEach((segment, i) => {
        const name =
          i === segments.length - 1 ? "___" + segment + "___" : segment;
        dirs[dir] = dirs[dir] || [];
        if (!dirs[dir].some((entry) => entry.name === name))
          dirs[dir].push({ name, isDirectory: true });
        dir += name + "/";
      });

      dirs[dir] = files.map((file, i) => ({
        name: i ? "___file___variation___" + i : "___file___",
        isDirectory: false,
        ...file,
      }));
    }

    removed = [];
    spyOn(bunnyStorage, "list").and.callFake(async (dir) => dirs[dir] || []);
    spyOn(bunnyStorage, "remove").and.callFake(async (path) => {
      removed.push(path);
    });
  }

  async function versionOf(blogID, path) {
    const stat = await folder.stat(blogID, path, { sha1: true });
    return contentVersion.fromFolderRecord(stat);
  }

  afterEach(async function () {
    await client.del(permaCache.STATE);
  });

  async function report(options = {}) {
    const lines = [];
    const totals = await permaCache.sweep({
      log: (line) => lines.push(line),
      ...options,
    });
    return { lines, totals };
  }

  it("matches the version a link is built with", async function () {
    const id = this.blog.id;
    await folder.write(id, "/a.txt", "one");

    expect(await versionOf(id, "/a.txt")).toBe(
      await contentVersion.fromFolder(
        id,
        "/a.txt",
        await folder.stat(id, "/a.txt")
      )
    );
  });

  it("reports a blog's stale folder files and keeps the current ones", async function () {
    const id = this.blog.id;
    await folder.write(id, "/a.txt", "one");
    await folder.write(id, "/my pic.jpg", "pic");
    const current = await versionOf(id, "/a.txt");
    const pic = await versionOf(id, "/my pic.jpg");
    const redirected = contentVersion.fromFolderStat(
      await folder.stat(id, "/a.txt")
    );

    zone([
      `/${id}/folder/v-${current}/a.txt`,
      `/${id}/folder/v-${redirected}/a.txt`,
      `/${id}/folder/v-deadbeef/a.txt`,
      `/${id}/folder/v-${pic}/my%20pic.jpg`,
      `/${id}/folder/v-${current}/gone.txt`,
      `/${id}/folder/v-pending/later.jpg`,
      `/${id}/folder/a.txt`,
      `/${id}/v-${current}/a.txt`,
    ]);
    spyOn(assets, "walkEntries").and.callFake(noGenerated);

    const { lines, totals } = await report({ only: id });

    expect(totals.stale).toBe(4);
    expect(lines).toContain(`${id} replaced: /${id}/folder/v-deadbeef/a.txt`);
    expect(lines).toContain(
      `${id} removed: /${id}/folder/v-${current}/gone.txt`
    );
    expect(lines).toContain(`${id} unversioned: /${id}/folder/a.txt`);
    expect(lines).toContain(`${id} unknown prefix: /${id}/v-${current}/a.txt`);
    expect(removed).toEqual([]);
  });

  it("reports generated files that are gone from the bucket", async function () {
    const id = this.blog.id;

    zone([`/${id}/_thumbnails/a/small.jpg`, `/${id}/_thumbnails/b/small.jpg`]);
    spyOn(assets, "walkEntries").and.callFake(() =>
      (async function* () {
        yield { relPath: "_thumbnails/a/small.jpg", modified: new Date() };
      })()
    );

    const { lines, totals } = await report({ only: id });

    expect(totals.stale).toBe(1);
    expect(lines).toContain(
      `${id} generated file gone: /${id}/_thumbnails/b/small.jpg`
    );
  });

  it("removes a deleted blog's directory, and only with apply", async function () {
    const gone = "blog_0123456789abcdef0123456789abcdef";

    zone([`/${gone}/_thumbnails/a/small.jpg`, `/${gone}/folder/v-1/a.txt`]);

    let { totals } = await report({ only: gone });

    expect(totals.deletedBlogs).toBe(1);
    expect(removed).toEqual([]);

    await report({ only: gone, apply: true });

    expect(removed).toEqual([BASE + gone + "/"]);
  });

  it("purges an _assets file rewritten since Perma-Cache copied it", async function () {
    const id = this.blog.id;

    zone([
      {
        path: `/${id}/_assets/doc/media/image1.png`,
        file: { lastChanged: "2026-01-01T00:00:00.000" },
      },
      {
        path: `/${id}/_assets/doc/media/image2.png`,
        file: { lastChanged: "2026-03-01T00:00:00.000" },
      },
    ]);
    spyOn(assets, "walkEntries").and.callFake(() =>
      (async function* () {
        const modified = new Date("2026-02-01T00:00:00Z");
        yield { relPath: "_assets/doc/media/image1.png", modified };
        yield { relPath: "_assets/doc/media/image2.png", modified };
      })()
    );

    const { lines, totals } = await report({ only: id });

    expect(totals.stale).toBe(1);
    expect(lines).toContain(
      `${id} generated file changed: /${id}/_assets/doc/media/image1.png`
    );
  });

  it("deletes the storage copies of old documentation versions", async function () {
    zone([
      "/documentation/v-current1/documentation.min.css",
      "/documentation/v-old00001/documentation.min.css",
    ]);
    spyOn(documentationURL, "versionOf").and.returnValue("current1");

    const { lines, totals } = await report({
      only: "documentation",
      apply: true,
    });

    expect(totals.stale).toBe(1);
    expect(lines).toContain(
      "documentation old documentation version: /documentation/v-old00001/documentation.min.css"
    );
    expect(removed).toEqual([
      BASE + "documentation/v-old00001/___documentation.min.css___/",
    ]);
  });

  it("deletes the storage copies of template outputs gone from Redis", async function () {
    const live = "ab" + "cd" + "0".repeat(28);
    const dead = "ab" + "cd" + "1".repeat(28);

    await client.set(templateKey.renderedOutput(live), "body{}");

    try {
      zone([
        `/template/ab/cd/${live.slice(4)}/style.css`,
        `/template/ab/cd/${dead.slice(4)}/style.css`,
      ]);

      const { totals } = await report({ only: "template", apply: true });

      expect(totals.stale).toBe(1);
      expect(removed).toEqual([
        BASE + `template/ab/cd/${dead.slice(4)}/___style.css___/`,
      ]);
    } finally {
      await client.del(templateKey.renderedOutput(live));
    }
  });

  it("finds static files whose bytes changed or which are gone", async function () {
    const name = fs
      .readdirSync(GLOBAL_STATIC_DIR + "/icons")
      .find((entry) =>
        fs.statSync(GLOBAL_STATIC_DIR + "/icons/" + entry).isFile()
      );
    const current = crypto
      .createHash("sha256")
      .update(fs.readFileSync(GLOBAL_STATIC_DIR + "/icons/" + name))
      .digest("hex")
      .toUpperCase();

    zone([
      { path: "/icons/" + name, file: { checksum: current } },
      {
        path: "/icons/" + name.replace(/(\.\w+)$/, ".copy$1"),
        file: { checksum: "AB" },
      },
      { path: "/icons/gone.svg", file: { checksum: "AB" } },
    ]);

    const { lines, totals } = await report({ only: "icons", apply: true });

    expect(totals.stale).toBe(2);
    expect(lines).toContain("icons static file gone: /icons/gone.svg");
    expect(removed).toContain(BASE + "icons/___gone.svg___/");
    expect(removed).not.toContain(BASE + `icons/___${name}___/`);
  });

  it("purges a static file one of whose variations has other bytes", async function () {
    const name = fs
      .readdirSync(GLOBAL_STATIC_DIR + "/icons")
      .find((entry) =>
        fs.statSync(GLOBAL_STATIC_DIR + "/icons/" + entry).isFile()
      );
    const current = crypto
      .createHash("sha256")
      .update(fs.readFileSync(GLOBAL_STATIC_DIR + "/icons/" + name))
      .digest("hex")
      .toUpperCase();

    zone([
      {
        path: "/icons/" + name,
        files: [{ checksum: current }, { checksum: "AB" }],
      },
    ]);

    const { lines, totals } = await report({ only: "icons", apply: true });

    expect(totals.stale).toBe(1);
    expect(lines).toContain(`icons static file changed: /icons/${name}`);
    expect(removed).toEqual([BASE + `icons/___${name}___/`]);
  });

  it("keeps a static file's directory when its purge fails", async function () {
    zone([{ path: "/icons/gone.svg", file: { checksum: "AB" } }]);
    const purgeCdnUrls = require.cache[require.resolve("helper/purgeCdnUrls")];
    const real = purgeCdnUrls.exports;
    purgeCdnUrls.exports = async () => false;

    try {
      delete require.cache[require.resolve("storage/sweep/permaCache")];
      const fresh = require("storage/sweep/permaCache");
      const totals = await fresh.sweep({
        only: "icons",
        apply: true,
        log: () => {},
      });

      expect(totals.failed).toBe(1);
      expect(removed).toEqual([]);
    } finally {
      purgeCdnUrls.exports = real;
      delete require.cache[require.resolve("storage/sweep/permaCache")];
      require("storage/sweep/permaCache");
    }
  });

  it("deletes anything else at the top level", async function () {
    zone(["/folder/v-1/blog_1/a.txt", "/health"]);

    const { totals } = await report({ apply: true });

    expect(totals.stale).toBe(2);
    expect(removed.sort()).toEqual([BASE + "___health___/", BASE + "folder/"]);
  });

  it("resumes a run from its cursor and waits a week after it finishes", async function () {
    zone(["/a-dir/x", "/b-dir/x"]);

    let time = 1000;
    const now = () => time;

    await client.hSet(permaCache.STATE, { startedAt: "1", cursor: "a-dir" });

    const totals = await permaCache.step(null, { now });

    expect(totals.stale).toBe(1);
    expect(removed).toEqual([BASE + "b-dir/"]);

    const state = await client.hGetAll(permaCache.STATE);

    expect(state.startedAt).toBeUndefined();
    expect(state.cursor).toBeUndefined();
    expect(state.finishedAt).toBe("1000");

    expect(await permaCache.step(null, { now })).toBe(null);

    time += 7 * 24 * 60 * 60 * 1000 + 1;
    removed.length = 0;

    expect((await permaCache.step(null, { now })).stale).toBe(2);
    expect(removed.sort()).toEqual([BASE + "a-dir/", BASE + "b-dir/"]);
  });

  it("deletes nothing when too many blogs look deleted", async function () {
    zone([
      "/blog_0123456789abcdef0123456789abcdef/_a/x.jpg",
      "/blog_1123456789abcdef0123456789abcdef/_a/x.jpg",
    ]);

    const err = await permaCache
      .sweep({ apply: true, maxDeletedBlogs: 1, log: () => {} })
      .catch((err) => err);

    expect(err instanceof Error).toBe(true);
    expect(removed).toEqual([]);
  });

  it("refuses when there isn't exactly one Perma-Cache directory", async function () {
    spyOn(bunnyStorage, "list").and.callFake(async () => [
      {
        name: "pullzone__" + config.bunny.pull_zone + "__1",
        isDirectory: true,
      },
      {
        name: "pullzone__" + config.bunny.pull_zone + "__2",
        isDirectory: true,
      },
    ]);

    expect(await permaCache.root().catch((err) => err instanceof Error)).toBe(
      true
    );
  });
});
