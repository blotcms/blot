describe("scripts/discover/import", function () {
  const sharp = require("sharp");
  const config = require("config");
  const Blog = require("models/blog");
  const Entry = require("models/entry");
  const assets = require("storage/assets");
  const Discover = require("models/discover");
  const { exportPosts } = require("../export");
  const { importPosts } = require("../import");

  global.test.blog();

  async function image(blogID, rel) {
    const data = await sharp({
      create: {
        width: 1600,
        height: 1000,
        channels: 3,
        background: "#336699",
      },
    })
      .jpeg()
      .toBuffer();

    await assets.write(blogID, rel, data);

    return config.cdn.origin + "/" + blogID + "/" + rel;
  }

  async function entry(blogID, path, overrides = {}) {
    const now = Date.now();

    await Entry.set(
      blogID,
      path,
      Object.assign(
        {
          id: path,
          guid: path + ":guid",
          url: "",
          permalink: "",
          title: "A post",
          titleTag: "<h1>A post</h1>",
          body: "<p>Words about things.</p>",
          summary: "Words about things.",
          teaser: "",
          teaserBody: "",
          more: false,
          html: "<h1>A post</h1><p>Words about things.</p>",
          slug: path.slice(1).replace(/\W/g, "-"),
          name: path.slice(1),
          path,
          size: 0,
          tags: [],
          dependencies: [],
          backlinks: [],
          internalLinks: [],
          menu: false,
          page: false,
          deleted: false,
          draft: false,
          scheduled: false,
          thumbnail: {},
          dateStamp: now,
          created: now,
          updated: now,
          metadata: {},
          exif: {},
        },
        overrides
      )
    );

    return Entry.get(blogID, path);
  }

  // Puts a post with the given images on Discover, and resolves to it
  async function feature(blogID, path, names, added) {
    const srcs = [];

    for (const name of names)
      srcs.push(await image(blogID, "_image_cache/" + name + ".jpg"));

    const post = await entry(blogID, path, {
      html: srcs.map((src) => `<img src="${src}">`).join(""),
    });
    const photos = await Discover.photos.derive(
      blogID,
      Discover.postID(blogID, post.id),
      names.map((name) => "_image_cache/" + name + ".jpg")
    );

    await Discover.add(blogID, post.id, photos, { added });

    return post;
  }

  beforeEach(async function () {
    await Blog.set(this.blog.id, { includeInDiscover: true });
  });

  it("exports oldest first by url and source, and skips a post whose entry is gone", async function () {
    const blogID = this.blog.id;
    const newer = await feature(blogID, "/newer.txt", ["n"], 2000);
    const older = await feature(blogID, "/older.txt", ["o"], 1000);
    const gone = await entry(blogID, "/gone.txt");

    await Discover.add(blogID, gone.id, [], { added: 1500 });
    await Entry.drop(blogID, gone.id);

    const { exported, skipped } = await exportPosts(42);

    expect(exported).toEqual({
      version: 1,
      exported: 42,
      posts: [
        {
          blogID,
          url: older.url,
          title: "A post",
          sources: ["_image_cache/o.jpg"],
          added: 1000,
        },
        {
          blogID,
          url: newer.url,
          title: "A post",
          sources: ["_image_cache/n.jpg"],
          added: 2000,
        },
      ],
    });
    expect(skipped.length).toBe(1);
    expect(skipped[0].reason).toMatch(/missing|no url/);
  });

  it("restores a removed post with its added time and photo", async function () {
    const blogID = this.blog.id;
    const post = await feature(blogID, "/one.txt", ["one"], 1234);
    const id = Discover.postID(blogID, post.id);
    const { exported } = await exportPosts();

    await Discover.remove(id);
    expect(await Discover.has(blogID, post.id)).toBe(false);

    const totals = await importPosts(exported, true);

    expect(totals.imported).toBe(1);

    const restored = await Discover.get(id);

    expect(restored.added).toBe(1234);
    expect(restored.photos.length).toBe(1);
    expect(restored.photos[0].source).toBe("_image_cache/one.jpg");
    expect(await assets.exists(blogID, restored.photos[0].path)).toBe(true);
  });

  it("writes nothing on a dry run", async function () {
    const blogID = this.blog.id;
    const post = await feature(blogID, "/dry.txt", ["dry"], 1234);
    const { exported } = await exportPosts();

    await Discover.remove(Discover.postID(blogID, post.id));

    const totals = await importPosts(exported, false);

    expect(totals.imported).toBe(1);
    expect(await Discover.has(blogID, post.id)).toBe(false);
    expect((await Discover.list({ all: true })).posts).toEqual([]);
  });

  it("drops a source which is no longer in the post", async function () {
    const blogID = this.blog.id;
    const post = await feature(blogID, "/two.txt", ["keep", "lost"], 1234);
    const { exported } = await exportPosts();

    await Discover.remove(Discover.postID(blogID, post.id));
    await entry(blogID, "/two.txt", {
      html: `<img src="${config.cdn.origin}/${blogID}/_image_cache/keep.jpg">`,
    });

    const reported = [];
    const totals = await importPosts(exported, true, (item, result) =>
      reported.push(result)
    );

    expect(totals.imported).toBe(1);
    expect(totals.photosMissing).toBe(1);
    expect(reported[0].missing).toEqual(["_image_cache/lost.jpg"]);

    const restored = await Discover.get(Discover.postID(blogID, post.id));

    expect(restored.photos.map((photo) => photo.source)).toEqual([
      "_image_cache/keep.jpg",
    ]);
  });

  it("skips a post already on Discover, and one with no entry or blog", async function () {
    const blogID = this.blog.id;
    const post = await feature(blogID, "/three.txt", ["three"], 1234);
    const id = Discover.postID(blogID, post.id);
    const before = await Discover.get(id);
    const { exported } = await exportPosts();

    exported.posts.push(
      { blogID, url: "/not-a-post", title: "", sources: [], added: 1 },
      { blogID: "blog_missing", url: "/x", title: "", sources: [], added: 1 }
    );

    const totals = await importPosts(exported, true);

    expect(totals).toEqual({
      imported: 0,
      already: 1,
      noBlog: 1,
      noEntry: 1,
      noPhotos: 0,
      photosMissing: 0,
    });
    expect(await Discover.get(id)).toEqual(before);
  });
});
