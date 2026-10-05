describe("Blog.set rebuilds entries linking to a new handle or domain", function () {
  var Blog = require("models/blog");
  var Entry = require("models/entry");
  var BLOT_CDN_TOKEN = require("blog/render/replaceFolderLinks/cdnToken");
  var rebuildEntriesOnNewHosts = require("../rebuildEntriesOnNewHosts");

  global.test.blog();

  var getEntry = (blogID, path) =>
    new Promise((resolve) => Entry.get(blogID, path, resolve));

  var getBlog = (blogID) =>
    new Promise((resolve, reject) =>
      Blog.get({ id: blogID }, (err, blog) => (err ? reject(err) : resolve(blog)))
    );

  var setBlog = (blogID, updates) =>
    new Promise((resolve, reject) =>
      Blog.set(blogID, updates, (err) => (err ? reject(err) : resolve()))
    );

  // Blog.set rebuilds in the background, so wait for the result.
  var waitFor = async (check) => {
    var end = Date.now() + 15000;

    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
  };

  beforeEach(async function () {
    await this.blog.write({
      path: "/photo.jpg",
      content: await global.test.fake.pngBuffer(),
    });
    await this.blog.write({
      path: "/linked.txt",
      content: "Link: /linked\n\n![A](https://new.example.com/photo.jpg)",
    });
    await this.blog.write({
      path: "/other.txt",
      content: "Link: /other\n\n![A](https://other.example.org/photo.jpg)",
    });
    await this.blog.rebuild();
  });

  it("bakes links on a newly added domain, leaving other hosts alone", async function () {
    var linked = await getEntry(this.blog.id, "/linked.txt");

    // The domain isn't the blog's yet, so it is just another host.
    expect(linked.html).toContain("https://new.example.com/photo.jpg");
    expect(linked.html).not.toContain(BLOT_CDN_TOKEN);

    await setBlog(this.blog.id, { domain: "new.example.com" });

    var rebuilt = await waitFor(async () => {
      var entry = await getEntry(this.blog.id, "/linked.txt");
      return entry.html.indexOf(BLOT_CDN_TOKEN) > -1;
    });

    expect(rebuilt).toBe(true);

    var other = await getEntry(this.blog.id, "/other.txt");

    expect(other.html).toContain("https://other.example.org/photo.jpg");
    expect(other.html).not.toContain(BLOT_CDN_TOKEN);
  });

  it("does nothing when the new hosts aren't in any entry", async function () {
    var former = await getBlog(this.blog.id);
    var before = await getEntry(this.blog.id, "/linked.txt");

    await setBlog(this.blog.id, { domain: "unused.example.com" });
    await rebuildEntriesOnNewHosts(this.blog.id, former);

    var after = await getEntry(this.blog.id, "/linked.txt");

    expect(after.html).toEqual(before.html);
  });
});
