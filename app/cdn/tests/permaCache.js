describe("cdn/permaCache", function () {
  global.test.blog();

  const config = require("config");
  const bunnyStorage = require("helper/bunnyStorage");
  const assets = require("storage/assets");
  const folder = require("storage/folder");
  const contentVersion = require("helper/contentVersion");
  const permaCache = require("cdn/permaCache");

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

    for (const path of paths) {
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

      dirs[dir] = [{ name: "___file___", isDirectory: false }];
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

    zone([
      `/${id}/folder/v-${current}/a.txt`,
      `/${id}/folder/v-deadbeef/a.txt`,
      `/${id}/folder/v-${pic}/my%20pic.jpg`,
      `/${id}/folder/v-${current}/gone.txt`,
      `/${id}/folder/v-pending/later.jpg`,
      `/${id}/folder/a.txt`,
      `/${id}/v-${current}/a.txt`,
    ]);
    spyOn(assets, "walk").and.callFake(async function* () {});

    const { lines, totals } = await report({ blogID: id });

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
    spyOn(assets, "walk").and.callFake(async function* () {
      yield "_thumbnails/a/small.jpg";
    });

    const { lines, totals } = await report({ blogID: id });

    expect(totals.stale).toBe(1);
    expect(lines).toContain(
      `${id} generated file gone: /${id}/_thumbnails/b/small.jpg`
    );
  });

  it("removes a deleted blog's directory, and only with apply", async function () {
    const gone = "blog_0123456789abcdef0123456789abcdef";

    zone([`/${gone}/_thumbnails/a/small.jpg`, `/${gone}/folder/v-1/a.txt`]);

    let { totals } = await report({ blogID: gone });

    expect(totals.deletedBlogs).toBe(1);
    expect(totals.deletedBlogURLs).toBe(2);
    expect(removed).toEqual([]);

    await report({ blogID: gone, apply: true });

    expect(removed).toEqual([BASE + gone + "/"]);
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
