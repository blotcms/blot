describe("models/discover", function () {
  const sharp = require("sharp");
  const config = require("config");
  const Blog = require("models/blog");
  const Entry = require("models/entry");
  const assets = require("storage/assets");
  const Discover = require("models/discover");

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

  beforeEach(async function () {
    await Blog.set(this.blog.id, { includeInDiscover: true });
  });

  it("shows recent dates as relative and older ones in full", function () {
    const { formatDate } = require("models/discover/list");
    const now = Date.UTC(2026, 10, 19, 12);
    const hour = 60 * 60 * 1000;

    expect(formatDate(now - 30 * 1000, "UTC", now)).toBe("just now");
    expect(formatDate(now - 5 * 60 * 1000, "UTC", now)).toBe("5m");
    expect(formatDate(now - 4 * hour, "UTC", now)).toBe("4h");
    expect(formatDate(now - 3 * 24 * hour, "UTC", now)).toBe("3d");
    expect(formatDate(now - 15 * 24 * hour, "UTC", now)).toBe("2w");
    expect(formatDate(now - 40 * 24 * hour, "UTC", now)).toBe(
      "10 October 2026"
    );
  });

  it("uses a token once, and reading it does not use it up", async function () {
    const token = await Discover.token.create(this.blog.id, "/a.txt");

    expect(await Discover.token.read(token)).toEqual({
      blogID: this.blog.id,
      entryID: "/a.txt",
    });
    expect(await Discover.token.read(token)).not.toBe(null);
    expect(await Discover.token.consume(token)).not.toBe(null);
    expect(await Discover.token.consume(token)).toBe(null);
    expect(await Discover.token.read(token)).toBe(null);
    expect(await Discover.token.read("../not-a-token")).toBe(null);
  });

  it("offers only the blog's own images from the CDN", async function () {
    const src = config.cdn.origin + "/" + this.blog.id + "/_image_cache/a.jpg";
    const other = config.cdn.origin + "/blog_other/_image_cache/b.jpg";

    const candidates = Discover.photos.candidates(this.blog.id, {
      html: `<img src="${src}"><img src="${src}"><img src="${other}"><img src="https://example.com/c.jpg">`,
    });

    expect(candidates).toEqual(["_image_cache/a.jpg"]);
  });

  it("lists an added post with its photo, and hides it while the site is excluded", async function () {
    const blogID = this.blog.id;
    const src = await image(blogID, "_image_cache/one.jpg");
    const post = await entry(blogID, "/one.txt", {
      html: `<p>Hello</p><img src="${src}">`,
    });

    const id = Discover.postID(blogID, post.id);
    const photos = await Discover.photos.derive(blogID, id, [
      "_image_cache/one.jpg",
    ]);

    expect(photos[0].width).toBe(1200);
    expect(await assets.exists(blogID, photos[0].path)).toBe(true);

    await Discover.add(blogID, post.id, photos);

    let { posts, next } = await Discover.list();
    expect(posts.length).toBe(1);
    expect(posts[0].title).toBe("A post");
    expect(posts[0].url).toContain(post.url);
    expect(posts[0].photos.length).toBe(1);
    expect(next).toBe(null);

    await Blog.set(blogID, { includeInDiscover: false });
    ({ posts } = await Discover.list());
    expect(posts).toEqual([]);

    ({ posts } = await Discover.list({ all: true }));
    expect(posts[0].hidden).toBe("The site has turned off Discover");

    await Blog.set(blogID, { includeInDiscover: true });
    ({ posts } = await Discover.list());
    expect(posts.length).toBe(1);
  });

  it("hides a post whose chosen photos were removed from it", async function () {
    const blogID = this.blog.id;
    const src = await image(blogID, "_image_cache/two.jpg");
    const post = await entry(blogID, "/two.txt", {
      html: `<img src="${src}">`,
    });
    const id = Discover.postID(blogID, post.id);

    await Discover.add(
      blogID,
      post.id,
      await Discover.photos.derive(blogID, id, ["_image_cache/two.jpg"])
    );

    await entry(blogID, "/two.txt", { html: "<p>No photo now</p>" });

    expect((await Discover.list()).posts).toEqual([]);
  });

  it("shows the card's own text in place of the post's, and keeps it when re-added", async function () {
    const blogID = this.blog.id;
    const src = await image(blogID, "_image_cache/three.jpg");
    const post = await entry(blogID, "/three.txt", {
      html: `<p>The post's own words</p><img src="${src}">`,
    });
    const id = Discover.postID(blogID, post.id);
    const derive = () =>
      Discover.photos.derive(blogID, id, ["_image_cache/three.jpg"]);

    await Discover.add(blogID, post.id, await derive());
    expect((await Discover.list()).posts[0].text).toEqual([]);

    await Discover.setText(id, "  Written   for the card ");
    expect((await Discover.list()).posts[0].text).toEqual([
      "Written for the card",
    ]);
    expect((await Discover.list()).posts[0].ownText).toBe(true);

    await Discover.add(blogID, post.id, await derive());
    expect((await Discover.list()).posts[0].text).toEqual([
      "Written for the card",
    ]);

    await Discover.setText(id, "");
    expect((await Discover.get(id)).text).toBe("");
    expect((await Discover.list()).posts[0].text).toEqual([]);

    expect(await Discover.setText("0123456789abcdef0123", "x")).toBe(null);
  });

  it("shows a post without photos as a text card and drops deleted posts", async function () {
    const blogID = this.blog.id;
    const post = await entry(blogID, "/text.txt");

    await Discover.add(blogID, post.id, []);

    let { posts } = await Discover.list();
    expect(posts[0].photos).toEqual([]);
    expect(posts[0].excerpt).toBe("Words about things.");

    await entry(blogID, "/text.txt", { deleted: true });
    ({ posts } = await Discover.list());
    expect(posts).toEqual([]);
  });

  it("pages newest first", async function () {
    const blogID = this.blog.id;

    for (const name of ["a", "b", "c"]) {
      const post = await entry(blogID, "/" + name + ".txt", { title: name });
      await Discover.add(blogID, post.id, []);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const first = await Discover.list({ limit: 2 });
    expect(first.posts.map((post) => post.title)).toEqual(["c", "b"]);
    expect(first.next).not.toBe(null);

    const second = await Discover.list({ limit: 2, before: first.next });
    expect(second.posts.map((post) => post.title)).toEqual(["a"]);
    expect(second.next).toBe(null);
  });

  it("removes a post with its photos, and all of a blog's posts", async function () {
    const blogID = this.blog.id;
    await image(blogID, "_image_cache/three.jpg");
    const post = await entry(blogID, "/three.txt");
    const id = Discover.postID(blogID, post.id);
    const photos = await Discover.photos.derive(blogID, id, [
      "_image_cache/three.jpg",
    ]);

    await Discover.add(blogID, post.id, photos);
    expect(await Discover.has(blogID, post.id)).toBe(true);

    expect(await Discover.remove(id)).toBe(true);
    expect(await Discover.has(blogID, post.id)).toBe(false);
    expect(await assets.exists(blogID, photos[0].path)).toBe(false);

    await Discover.add(blogID, post.id, []);
    expect(await Discover.removeBlog(blogID)).toBe(1);
    expect((await Discover.list({ all: true })).posts).toEqual([]);
  });
});
