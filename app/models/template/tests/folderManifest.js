describe("updateCdnManifest folder files", function () {
  require("./setup")({ createTemplate: true });

  const crypto = require("crypto");
  const { promisify } = require("util");
  const client = require("models/client");
  const Blog = require("models/blog");
  const Template = require("../index");
  const key = require("../key");
  const updateCdnManifest = promisify(require("../util/updateCdnManifest"));
  const rebuildDependents = promisify(require("sync/update/rebuildDependents"));
  const renderView = require("blog/render/view");
  const config = require("config");

  const getMetadata = promisify(Template.getMetadata);
  const dropTemplate = promisify(Template.drop);
  const createTemplate = promisify(Template.create);
  const blogSet = promisify(Blog.set);
  const blogGet = promisify(Blog.get);

  const version = (content) =>
    crypto.createHash("sha1").update(content).digest("hex").slice(0, 8);

  beforeEach(async function () {
    await blogSet(this.blog.id, { template: this.template.id });

    // Installs a different template, so this.template no longer is
    this.uninstall = async () => {
      const other = await createTemplate(this.blog.id, "other", {});
      await blogSet(this.blog.id, { template: other.id });
    };

    this.manifest = async () => (await getMetadata(this.template.id)).cdn;
    this.dependents = (path) =>
      client.sMembers(key.templateDependents(this.blog.id, path));
  });

  describe("manifest entries", function () {
    it("resolves a literal {{#cdn}} target to a versioned folder file", async function () {
      await this.write({ path: "/images/a.png", content: "one" });
      await this.setView({
        name: "index.html",
        content: '<img src="{{#cdn}}/images/a.png{{/cdn}}">',
      });

      expect((await this.manifest())["images/a.png"]).toEqual({
        path: "/images/a.png",
        version: version("one"),
      });
    });

    it("resolves a literal link wrapped at save time", async function () {
      await this.write({ path: "/a.png", content: "one" });
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });

      expect((await this.manifest())["a.png"]).toEqual({
        path: "/a.png",
        version: version("one"),
      });
    });

    it("keeps the query string out of the lookup", async function () {
      await this.write({ path: "/a.png", content: "one" });
      await this.setView({ name: "index.html", content: '<img src="/a.png?v=2#x">' });

      expect((await this.manifest())["a.png?v=2#x"]).toEqual({
        path: "/a.png",
        version: version("one"),
      });
    });

    it("decodes percent-encoded paths", async function () {
      await this.write({ path: "/my photo.png", content: "one" });
      await this.setView({ name: "index.html", content: '<img src="/my%20photo.png">' });

      expect((await this.manifest())["my%20photo.png"]).toEqual({
        path: "/my photo.png",
        version: version("one"),
      });
    });

    it("finds a file whatever the case of the link", async function () {
      await this.write({ path: "/Images/Photo.PNG", content: "one" });
      await this.setView({ name: "index.html", content: '<img src="/images/photo.png">' });

      const entry = (await this.manifest())["images/photo.png"];

      expect(entry.path.toLowerCase()).toBe("/images/photo.png");
      expect(entry.version).toBe(version("one"));
    });

    it("resolves reserved global paths without a version", async function () {
      await this.setView({ name: "index.html", content: '<img src="/icons/search.svg">' });

      expect((await this.manifest())["icons/search.svg"]).toEqual({
        path: "/icons/search.svg",
      });
    });

    it("leaves views as plain hashes, ahead of folder files of the same name", async function () {
      await this.write({ path: "/style.css", content: "folder file" });
      await this.setView({
        name: "index.html",
        content: '<link href="{{#cdn}}/style.css{{/cdn}}">',
      });
      await this.setView({ name: "style.css", content: "body{color:red}" });

      expect((await this.manifest())["style.css"]).toEqual(jasmine.any(String));
    });

    it("never turns a wrapped link into a view", async function () {
      await this.write({ path: "/other.png", content: "one" });
      await this.setView({ name: "feed.rss", content: "<rss></rss>" });
      await this.setView({
        name: "index.html",
        content: '<link href="/feed.rss"><img src="/other.png">',
      });

      const manifest = await this.manifest();

      expect(manifest["feed.rss"]).toBeUndefined();
      expect(manifest["other.png"]).toEqual(jasmine.any(Object));
    });

    it("leaves out a missing file, but depends on it", async function () {
      await this.setView({ name: "index.html", content: '<img src="/missing.png">' });

      expect((await this.manifest())["missing.png"]).toBeUndefined();
      expect(await this.dependents("/missing.png")).toEqual([this.template.id]);
    });

    it("picks up a file created later", async function () {
      await this.setView({ name: "index.html", content: '<img src="/late.png">' });
      await this.write({ path: "/late.png", content: "one" });
      await updateCdnManifest(this.template.id);

      expect((await this.manifest())["late.png"].version).toBe(version("one"));
    });

    it("gives a changed file a new version", async function () {
      await this.write({ path: "/a.png", content: "one" });
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });
      await this.write({ path: "/a.png", content: "two" });
      await updateCdnManifest(this.template.id);

      expect((await this.manifest())["a.png"].version).toBe(version("two"));
    });

    it("drops the entry when the file is deleted", async function () {
      await this.write({ path: "/a.png", content: "one" });
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });
      await this.remove("/a.png");
      await updateCdnManifest(this.template.id);

      expect((await this.manifest())["a.png"]).toBeUndefined();
      expect(await this.dependents("/a.png")).toEqual([this.template.id]);
    });

    it("drops the entry when the link is removed", async function () {
      await this.write({ path: "/a.png", content: "one" });
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });
      await this.setView({ name: "index.html", content: "<p>no image</p>" });

      expect((await this.manifest())["a.png"]).toBeUndefined();
    });

    it("drops the old file when a link is replaced", async function () {
      await this.write({ path: "/a.png", content: "one" });
      await this.write({ path: "/b.png", content: "two" });
      await this.setView({ name: "index.html", content: '<img src="{{#cdn}}/a.png{{/cdn}}">' });
      await this.setView({ name: "index.html", content: '<img src="{{#cdn}}/b.png{{/cdn}}">' });

      const manifest = await this.manifest();

      expect(manifest["a.png"]).toBeUndefined();
      expect(manifest["b.png"]).toEqual(jasmine.objectContaining({ path: "/b.png" }));
      expect(await this.dependents("/a.png")).toEqual([]);
    });

    it("renders a view's folder links before hashing it", async function () {
      await this.write({ path: "/a.png", content: "one" });
      await this.setView({
        name: "index.html",
        content: '<link href="{{#cdn}}/style.css{{/cdn}}">',
      });
      await this.setView({ name: "style.css", content: "a{background:url(/a.png)}" });

      const before = (await this.manifest())["style.css"];

      await this.write({ path: "/a.png", content: "two" });
      await updateCdnManifest(this.template.id);

      const manifest = await this.manifest();

      expect(manifest["style.css"]).not.toBe(before);
      expect(manifest["a.png"].version).toBe(version("two"));

      const rendered = await renderView(this.template.id, "style.css");

      expect(rendered).toBe(
        `a{background:url(${config.cdn.origin}/folder/v-${version("two")}/${this.blog.id}/a.png)}`
      );
    });

    it("does not compute a manifest for a template that is not installed", async function () {
      await this.write({ path: "/a.png", content: "one" });
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });
      expect(await this.dependents("/a.png")).toEqual([this.template.id]);

      await this.uninstall();
      await updateCdnManifest(this.template.id);

      expect(await this.manifest()).toEqual({});
      expect(await this.dependents("/a.png")).toEqual([]);
    });
  });

  describe("values which never pass through a view's text", function () {
    const setMetadata = promisify(Template.setMetadata);

    it("resolves a template local which links to a folder file", async function () {
      await this.write({ path: "/img/logo.png", content: "one" });
      await setMetadata(this.template.id, { locals: { logo: "/img/logo.png" } });
      await updateCdnManifest(this.template.id);

      expect((await this.manifest())["img/logo.png"]).toEqual({
        path: "/img/logo.png",
        version: version("one"),
      });
    });

    it("resolves a nested local and an absolute link on the blog's own host", async function () {
      await this.write({ path: "/img/a.png", content: "one" });
      await this.write({ path: "/img/b.png", content: "two" });
      await setMetadata(this.template.id, {
        locals: {
          site: { images: [`https://${this.blog.handle}.${config.host}/img/a.png`] },
        },
      });
      await this.setView({
        name: "index.html",
        content: "<p></p>",
        locals: { hero: "/img/b.png", title: "hello.world" },
      });

      const manifest = await this.manifest();

      expect(manifest["img/a.png"].version).toBe(version("one"));
      expect(manifest["img/b.png"].version).toBe(version("two"));
      expect(Object.keys(manifest).sort()).toEqual(["img/a.png", "img/b.png"]);
    });

    it("resolves a literal {{#asset}} section", async function () {
      await this.write({ path: "/img/a.png", content: "one" });
      await this.write({ path: "/img/b.png", content: "two" });
      await this.setView({
        name: "index.html",
        content:
          "{{#asset}}/img/a.png{{/asset}} {{#asset}}img/b.png{{/asset}} {{#asset}}{{dynamic}}{{/asset}}",
      });

      const manifest = await this.manifest();

      expect(manifest["img/a.png"].version).toBe(version("one"));
      expect(manifest["img/b.png"].version).toBe(version("two"));
    });

    it("resolves a link in an inline package.json partial", async function () {
      await this.write({ path: "/img/a.png", content: "one" });
      await this.setView({
        name: "index.html",
        content: "{{> inline}}",
        partials: { inline: '<img src="/img/a.png">' },
      });

      expect((await this.manifest())["img/a.png"].version).toBe(version("one"));
    });

    it("never turns any of them into a view", async function () {
      await this.setView({ name: "feed.rss", content: "<rss></rss>" });
      await this.setView({
        name: "index.html",
        content: "{{#asset}}/feed.rss{{/asset}}",
        locals: { feed: "/feed.rss" },
        partials: { inline: '<link href="/feed.rss">' },
      });

      expect((await this.manifest())["feed.rss"]).toBeUndefined();
    });

    it("depends on a file which doesn't exist yet", async function () {
      await this.setView({
        name: "index.html",
        content: "<p></p>",
        locals: { hero: "/img/later.png" },
      });

      expect(await this.dependents("/img/later.png")).toEqual([this.template.id]);
    });
  });

  describe("relative links in CSS", function () {
    it("resolves against the root", async function () {
      await this.write({ path: "/img/a.png", content: "root" });
      await this.setView({
        name: "index.html",
        content: '<link href="{{#cdn}}/style.css{{/cdn}}">',
      });
      await this.setView({
        name: "style.css",
        url: "/css/style.css",
        content: "a{background:url(img/a.png)}",
      });

      expect((await this.manifest())["img/a.png"]).toEqual({
        path: "/img/a.png",
        version: version("root"),
      });

      expect(await renderView(this.template.id, "style.css")).toContain(
        `/folder/v-${version("root")}/${this.blog.id}/img/a.png`
      );
    });
  });

  describe("wrapped links", function () {
    it("never wraps links for a template the blog does not own", async function () {
      await this.write({ path: "/a.png", content: "one" });
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });

      const getFullView = promisify(Template.getFullView);
      const response = await getFullView("blog_somebodyelse", this.template.id, "index.html");

      expect(response[4]).toBe('<img src="/a.png">');
    });

    it("treats a target the author also wrote by hand as the author's", async function () {
      await this.setView({ name: "style.css", content: "a{color:red}" });
      await this.setView({
        name: "index.html",
        content: '<link href="{{#cdn}}style.css{{/cdn}}"><link href="/style.css">',
      });

      expect((await this.manifest())["style.css"]).toEqual(jasmine.any(String));
    });

    it("strips the blog's own hosts, as the render does", async function () {
      await this.write({ path: "/a.png", content: "one" });
      await this.setView({
        name: "index.html",
        content: `<img src="https://${this.blog.handle}.${config.host}/a.png">`,
      });

      expect((await this.manifest())["a.png"]).toEqual({
        path: "/a.png",
        version: version("one"),
      });
    });

    it("picks up links to a new domain, and bumps the cacheID", async function () {
      const domain = "folder-links-" + Date.now() + ".example.com";

      await this.write({ path: "/a.png", content: "one" });
      await this.setView({
        name: "index.html",
        content: `<img src="https://${domain}/a.png">`,
      });

      expect((await this.manifest())["a.png"]).toBeUndefined();

      const before = (await blogGet({ id: this.blog.id })).cacheID;

      await blogSet(this.blog.id, { domain });

      expect((await blogGet({ id: this.blog.id })).cacheID).toBeGreaterThan(before);

      // Blog.set regenerates the manifest in the background
      const end = Date.now() + 10000;
      while (!(await this.manifest())["a.png"] && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 100));

      expect((await this.manifest())["a.png"]).toEqual({
        path: "/a.png",
        version: version("one"),
      });
    });
  });

  describe("dependency index", function () {
    it("is keyed by the lowercased path", async function () {
      await this.setView({ name: "index.html", content: '<img src="/Images/A.PNG">' });

      expect(await this.dependents("/images/a.png")).toEqual([this.template.id]);
      expect(await this.dependents("/IMAGES/a.PNG")).toEqual([this.template.id]);
      expect(
        await client.sMembers(
          "blog:" + this.blog.id + ":template_dependents:/images/a.png"
        )
      ).toEqual([this.template.id]);
    });

    it("is remembered in the template's metadata", async function () {
      await this.setView({
        name: "index.html",
        content: '<img src="/b.png"><img src="/A.png">',
      });

      expect((await getMetadata(this.template.id)).fileDependencies).toEqual([
        "/a.png",
        "/b.png",
      ]);
    });

    it("forgets files that are no longer linked to", async function () {
      await this.setView({
        name: "index.html",
        content: '<img src="/a.png"><img src="/b.png">',
      });
      await this.setView({ name: "index.html", content: '<img src="/b.png">' });

      expect(await this.dependents("/a.png")).toEqual([]);
      expect(await this.dependents("/b.png")).toEqual([this.template.id]);
      expect((await getMetadata(this.template.id)).fileDependencies).toEqual(["/b.png"]);
    });

    it("forgets files when the view that linked to them is dropped", async function () {
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });
      await this.dropView("index.html");

      expect(await this.dependents("/a.png")).toEqual([]);
    });

    it("is repaired if an entry is lost", async function () {
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });
      await client.del(key.templateDependents(this.blog.id, "/a.png"));
      await updateCdnManifest(this.template.id);

      expect(await this.dependents("/a.png")).toEqual([this.template.id]);
    });

    it("is cleaned up when the template is dropped", async function () {
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });
      await this.uninstall();
      await dropTemplate(this.blog.id, this.template.name);

      expect(await this.dependents("/a.png")).toEqual([]);
    });

    it("is no longer pending regeneration once the template is dropped", async function () {
      const pending = key.templateManifestsPending(this.blog.id);

      await this.setView({ name: "index.html", content: '<img src="{{#cdn}}/a.png{{/cdn}}">' });
      await client.sAdd(pending, this.template.id);
      await this.uninstall();
      await dropTemplate(this.blog.id, this.template.name);

      expect(await client.sIsMember(pending, this.template.id)).toBeFalsy();
    });

    it("is not copied to a cloned template", async function () {
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });

      const clone = await createTemplate(this.blog.id, "copy", {
        cloneFrom: this.template.id,
      });

      expect((await getMetadata(clone.id)).fileDependencies).toBeUndefined();
      expect(await this.dependents("/a.png")).toEqual([this.template.id]);
    });
  });

  describe("when a file in the blog's folder changes", function () {
    const regenerateTemplateManifests = promisify(
      require("sync/update/regenerateTemplateManifests")
    );
    const pending = (blogID) =>
      client.sMembers(key.templateManifestsPending(blogID));

    it("marks dependent templates as pending without regenerating anything", async function () {
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });
      await this.write({ path: "/a.png", content: "one" });

      const before = (await blogGet({ id: this.blog.id })).cacheID;

      await rebuildDependents(this.blog.id, "/a.png");

      expect(await pending(this.blog.id)).toEqual([this.template.id]);
      expect((await this.manifest())["a.png"]).toBeUndefined();
      expect((await blogGet({ id: this.blog.id })).cacheID).toBe(before);
    });

    it("regenerates each pending template once, when asked", async function () {
      await this.setView({ name: "index.html", content: '<img src="/a.png"><img src="/b.png">' });
      await this.write({ path: "/a.png", content: "one" });
      await this.write({ path: "/b.png", content: "two" });

      await rebuildDependents(this.blog.id, "/a.png");
      await rebuildDependents(this.blog.id, "/b.png");

      // however many of its files changed, the template is pending once
      expect(await pending(this.blog.id)).toEqual([this.template.id]);

      const log = jasmine.createSpy("log");

      expect(await regenerateTemplateManifests(this.blog.id, log)).toBe(1);

      const manifest = await this.manifest();

      expect(manifest["a.png"].version).toBe(version("one"));
      expect(manifest["b.png"].version).toBe(version("two"));
      expect(await pending(this.blog.id)).toEqual([]);
    });

    it("matches the path whatever its case", async function () {
      await this.setView({ name: "index.html", content: '<img src="/Photos/A.png">' });
      await rebuildDependents(this.blog.id, "/photos/a.PNG");

      expect(await pending(this.blog.id)).toEqual([this.template.id]);
    });

    it("marks nothing for a file no template links to", async function () {
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });
      await rebuildDependents(this.blog.id, "/unrelated.png");

      expect(await pending(this.blog.id)).toEqual([]);
    });

    it("keeps going when a template fails to update", async function () {
      await this.setView({ name: "index.html", content: '<img src="/a.png">' });
      await this.write({ path: "/a.png", content: "one" });
      await client.sAdd(key.templateManifestsPending(this.blog.id), [
        "nonexistent:template",
        this.template.id,
      ]);

      const log = jasmine.createSpy("log");

      expect(await regenerateTemplateManifests(this.blog.id, log)).toBe(1);
      expect(log).toHaveBeenCalled();
      expect((await this.manifest())["a.png"].version).toBe(version("one"));
      // the failed one stays for the next sync
      expect(await pending(this.blog.id)).toEqual(["nonexistent:template"]);
    });
  });
});
