// A sync which builds several files at once must store what one which builds
// them in turn stores. Each run below syncs the same set of changes, once in
// series and then many times three at a time, with a random delay around
// every build so the builds and saves interleave differently each time.
describe("sync building files concurrently", function () {
  const sync = require("../index");
  const updateAll = require("../updateAll");
  const folder = require("storage/folder");
  const Entry = require("models/entry");
  const Blog = require("models/blog");
  const buildFlags = require("build/flags");

  const ITERATIONS = 20;
  const TIMEOUT = 10 * 60 * 1000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const jitter = () => sleep(Math.floor(Math.random() * 25));

  global.test.blog();

  beforeEach(async function () {
    await this.blog.update({
      plugins: Object.assign({}, this.blog.plugins, {
        wikilinks: { enabled: true, options: {} },
      }),
    });

    // A delay before each build reads the folder and Redis, and another
    // before its entry is saved
    const collect = buildFlags.collect;
    spyOn(buildFlags, "collect").and.callFake(async function (fn) {
      await jitter();
      const collected = await collect.call(buildFlags, fn);
      await jitter();
      return collected;
    });
  });

  function syncPaths(blogID, paths, limit) {
    return sync(blogID, (syncFolder) =>
      updateAll(blogID, paths, (path) => syncFolder.update(path), { limit })
    );
  }

  // What is in the folder before the changes, synced in an earlier sync
  function before(p) {
    return [
      [`/${p}/old-target.txt`, `Link: ${p}-old-target\n\nOld target`],
      [`/${p}/_data.csv`, "a,b\n1,2"],
      [
        `/${p}/uses-data.txt`,
        `Link: ${p}-uses-data\n\n[data](/${p}/_data.csv)`,
      ],
      [`/${p}/doomed.txt`, `Link: ${p}-doomed\n\n[data](/${p}/_data.csv)`],
    ];
  }

  // The changes: a wikilink to a new post, two new links to an existing
  // post, two menu pages, a "+" folder's two files, a changed file two posts
  // depend on, and one of those posts deleted
  function changes(p) {
    return {
      write: [
        // Before its target, so that in series the target's save rebuilds
        // it as a dependent
        [`/${p}/wikilinker.md`, `Link: ${p}-wikilinker\n\nSee [[target]]`],
        [`/${p}/target.md`, `Link: ${p}-target\n\n# Target`],
        [`/${p}/linker-1.txt`, `Link: ${p}-linker-1\n\n[t](/${p}-old-target)`],
        [`/${p}/linker-2.txt`, `Link: ${p}-linker-2\n\n[t](/${p}-old-target)`],
        [`/${p}/page-1.txt`, `Menu: yes\nLink: ${p}-page-1\n\nPage one`],
        [`/${p}/page-2.txt`, `Menu: yes\nLink: ${p}-page-2\n\nPage two`],
        [`/${p}/album+/a.txt`, "Alpha"],
        [`/${p}/album+/b.txt`, "Beta"],
        [`/${p}/_data.csv`, "a,b\n3,4"],
      ],
      remove: [`/${p}/doomed.txt`],
    };
  }

  async function run(blog, p, limit) {
    const existing = before(p);

    for (const [path, content] of existing)
      await folder.write(blog.id, path, content);

    await syncPaths(
      blog.id,
      existing.map(([path]) => path),
      1
    );

    const usesDataBefore = (await Entry.get(blog.id, `/${p}/uses-data.txt`))
      .html;

    const { write, remove } = changes(p);

    for (const [path, content] of write)
      await folder.write(blog.id, path, content);
    for (const path of remove) await folder.remove(blog.id, path);

    await syncPaths(blog.id, write.map(([path]) => path).concat(remove), limit);

    return summarise(blog, p, usesDataBefore);
  }

  async function summarise(blog, p, usesDataBefore) {
    const strip = (value) => String(value).split(p).join("P");
    const get = (path) => Entry.get(blog.id, `/${p}/${path}`);

    const target = await get("target.md");
    const wikilinker = await get("wikilinker.md");
    const oldTarget = await get("old-target.txt");
    const usesData = await get("uses-data.txt");
    const doomed = await get("doomed.txt");
    const album = await get("album");

    const menu = (await Blog.get({ id: blog.id })).menu
      .filter((item) => item.id.indexOf(`/${p}/`) === 0)
      .map((item) => strip(item.id))
      .sort();

    return {
      targetUrl: strip(target.url),
      wikilinkResolved: wikilinker.html.indexOf(`href="${target.url}"`) > -1,
      backlinks: oldTarget.backlinks.map(strip).sort(),
      usesDataRebuilt: usesData.html !== usesDataBefore,
      doomedDeleted: !doomed || doomed.deleted,
      album:
        !!album &&
        !album.deleted &&
        album.html.indexOf("Alpha") > -1 &&
        album.html.indexOf("Beta") > -1,
      menu,
    };
  }

  it(
    "stores what building them in turn stores",
    async function () {
      const serial = await run(this.blog, "serial", 1);

      // What syncing in turn gives, so the comparison means something
      expect(serial).toEqual({
        targetUrl: "/P-target",
        wikilinkResolved: true,
        backlinks: ["/P-linker-1", "/P-linker-2"],
        usesDataRebuilt: true,
        doomedDeleted: true,
        album: true,
        menu: ["/P/page-1.txt", "/P/page-2.txt"],
      });

      for (let i = 0; i < ITERATIONS; i++) {
        const concurrent = await run(this.blog, "run" + i, 3);
        expect(concurrent).toEqual(serial);
      }
    },
    TIMEOUT
  );
});
