// Entry.set for different entries of one blog at once, as a sync building
// several files at a time makes them. Each scenario is saved once in series,
// then many times with every save started at once, and the stored state must
// come out the same. The state compared doesn't depend on the order of the
// saves: which of four entries asking for one url gets it differs from run to
// run, but the four urls taken, and who depends on whom, must not.
describe("entry.set run concurrently for one blog", function () {
  require("./setup")();

  const folder = require("storage/folder");
  const build = require("build");
  const Blog = require("models/blog");
  const client = require("models/client");
  const key = require("../key");
  const tagKey = require("models/tags/key");

  const ITERATIONS = 20;
  const TIMEOUT = 5 * 60 * 1000;

  // Four entries which ask for one url, four sharing a tag, four new links to
  // one existing target, and four menu pages. Every file is new, so each run
  // gets its own prefix.
  function files(prefix) {
    const list = [];

    for (let i = 1; i <= 4; i++) {
      list.push({
        path: `/${prefix}/same-${i}.txt`,
        contents: `Link: ${prefix}-same\n\nSame url ${i}`,
      });
      list.push({
        path: `/${prefix}/tagged-${i}.txt`,
        contents: `Tags: ${prefix}-shared, ${prefix}-own-${i}\n\nTagged ${i}`,
      });
      list.push({
        path: `/${prefix}/linker-${i}.txt`,
        contents: `Link: ${prefix}-linker-${i}\n\n[target](/${prefix}-target)`,
      });
      list.push({
        path: `/${prefix}/page-${i}.txt`,
        contents: `Menu: yes\nLink: ${prefix}-page-${i}\n\nPage ${i}`,
      });
    }

    return list;
  }

  // The target of the links is saved first, as it would be in an earlier
  // sync: backlinks are only added to an entry which exists.
  async function createTarget(blog, prefix) {
    const path = `/${prefix}/target.txt`;

    await folder.write(blog.id, path, `Link: ${prefix}-target\n\nTarget`);

    return build(blog, path);
  }

  async function buildAll(blog, list) {
    const built = [];

    for (const { path, contents } of list) {
      await folder.write(blog.id, path, contents);
      built.push(await build(blog, path));
    }

    return built;
  }

  // The parts of the stored state the races could break, with the run's
  // prefix taken out so two runs compare
  async function summarise(blog, prefix) {
    const strip = (value) => value.split(prefix).join("PREFIX");
    const entries = {};

    for (const { path } of files(prefix).concat({
      path: `/${prefix}/target.txt`,
    })) {
      const entry = await this.get(path);

      entries[strip(path)] = {
        url: strip(entry.url),
        backlinks: entry.backlinks.map(strip).sort(),
        dependencies: entry.dependencies.map(strip).sort(),
        // Whether the url key points back at this entry
        ownsUrl: (await client.get(key.url(blog.id, entry.url))) === entry.id,
      };
    }

    // Which entry gets which of the four urls depends on the order of the
    // saves. Keep the urls taken, and replace each dependency on the entry
    // which got the plain url with a marker, so every order compares equal.
    const same = [1, 2, 3, 4].map((i) => `/PREFIX/same-${i}.txt`);
    const owner = same.find((path) => entries[path].url === "/PREFIX-same");
    const sameUrls = [];

    for (const path of same) {
      const summary = entries[path];
      delete entries[path];
      sameUrls.push(summary.url);
      summary.dependencies = summary.dependencies.map((dependency) =>
        dependency === owner ? "OWNER" : dependency
      );
      entries["same " + summary.url] = summary;
    }

    const menu = (await Blog.get({ id: blog.id })).menu
      .filter((item) => item.id.indexOf(`/${prefix}/`) === 0)
      .map((item) => ({ id: strip(item.id), url: strip(item.url) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));

    const tagged = (
      await client.zRange(tagKey.sortedTag(blog.id, `${prefix}-shared`), 0, -1)
    )
      .map(strip)
      .sort();

    const popularity = await client.zScore(
      tagKey.popular(blog.id),
      `${prefix}-shared`
    );

    const listed = {};

    for (const list of ["entries", "pages"]) {
      listed[list] = (
        await client.zRange("blog:" + blog.id + ":" + list, 0, -1)
      )
        .filter((id) => id.indexOf(`/${prefix}/`) === 0)
        .map(strip)
        .sort();
    }

    return {
      entries,
      sameUrls: sameUrls.sort(),
      menu,
      tagged,
      popularity,
      listed,
    };
  }

  async function run(blog, prefix, concurrently) {
    const target = await createTarget(blog, prefix);
    await this.setEntry(target);

    const built = await buildAll(blog, files(prefix));

    if (concurrently) {
      // The target is saved again alongside the others, as a rebuild of
      // a dependent does while its backlinks are being added
      await Promise.all(
        built.concat(target).map((entry) => this.setEntry(entry))
      );
    } else {
      for (const entry of built) await this.setEntry(entry);
      await this.setEntry(target);
    }

    return summarise.call(this, blog, prefix);
  }

  beforeEach(function () {
    const set = require("../set");
    this.setEntry = (entry) => set(this.blog.id, entry.path, entry);
  });

  it(
    "stores what saving one at a time stores",
    async function () {
      const serial = await run.call(this, this.blog, "serial", false);

      // What saving one at a time gives, so a broken comparison can't
      // pass by comparing two empty summaries
      expect(serial.sameUrls).toEqual([
        "/PREFIX-same",
        "/PREFIX-same-2",
        "/PREFIX-same-3",
        "/PREFIX-same-4",
      ]);
      expect(serial.entries["/PREFIX/target.txt"].backlinks).toEqual([
        "/PREFIX-linker-1",
        "/PREFIX-linker-2",
        "/PREFIX-linker-3",
        "/PREFIX-linker-4",
      ]);
      expect(serial.menu.length).toBe(4);
      expect(serial.tagged.length).toBe(4);
      expect(serial.popularity).toBe(4);

      for (let i = 0; i < ITERATIONS; i++) {
        const concurrent = await run.call(this, this.blog, "run" + i, true);
        expect(concurrent).toEqual(serial);
      }
    },
    TIMEOUT
  );

  it(
    "keeps every backlink when the linkers are saved at once and then deleted at once",
    async function () {
      for (let i = 0; i < ITERATIONS; i++) {
        const prefix = "drop" + i;
        const target = await createTarget(this.blog, prefix);
        await this.setEntry(target);

        const linkers = await buildAll(
          this.blog,
          files(prefix).filter(({ path }) => path.includes("/linker-"))
        );

        await Promise.all(linkers.map((entry) => this.setEntry(entry)));

        expect((await this.get(target.path)).backlinks.sort()).toEqual([
          `/${prefix}-linker-1`,
          `/${prefix}-linker-2`,
          `/${prefix}-linker-3`,
          `/${prefix}-linker-4`,
        ]);

        await Promise.all(linkers.map((entry) => this.drop(entry.path)));

        expect((await this.get(target.path)).backlinks).toEqual([]);
      }
    },
    TIMEOUT
  );

  it(
    "keeps the menu whole when pages join and leave it at once",
    async function () {
      for (let i = 0; i < ITERATIONS; i++) {
        const prefix = "menu" + i;
        const pages = await buildAll(
          this.blog,
          files(prefix).filter(({ path }) => path.includes("/page-"))
        );

        await Promise.all(pages.map((entry) => this.setEntry(entry)));

        const ids = async () =>
          (await Blog.get({ id: this.blog.id })).menu
            .map((item) => item.id)
            .filter((id) => id.indexOf(`/${prefix}/`) === 0)
            .sort();

        expect(await ids()).toEqual(pages.map((entry) => entry.path).sort());

        // Two leave the menu while the other two are saved again
        await Promise.all([
          this.drop(pages[0].path),
          this.drop(pages[1].path),
          this.setEntry(pages[2]),
          this.setEntry(pages[3]),
        ]);

        expect(await ids()).toEqual([pages[2].path, pages[3].path].sort());
      }
    },
    TIMEOUT
  );
});
