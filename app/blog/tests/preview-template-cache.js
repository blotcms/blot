describe("preview of a template the blog hasn't installed", function () {
  require("./util/setup")();

  const config = require("config");
  const { promisify } = require("util");
  const Template = require("models/template");
  const Blog = require("models/blog");
  const create = promisify(Template.create);
  const setView = promisify(Template.setView);
  const getBlog = promisify(Blog.get);

  it("shows a saved change without bumping the blog's cacheID", async function () {
    await create(this.blog.id, "other", {});
    const templateID = this.blog.id + ":other";
    const preview =
      config.protocol +
      "preview-of-my-other-on-" +
      this.blog.handle +
      "." +
      config.host +
      "/";

    await setView(templateID, { name: "entries.html", content: "First" });
    const res = await this.fetch(preview);
    expect(await res.text()).toBe("First");

    const before = (await getBlog({ id: this.blog.id })).cacheID;

    await setView(templateID, { name: "entries.html", content: "Second" });

    expect((await getBlog({ id: this.blog.id })).cacheID).toBe(before);
    const updated = await this.fetch(preview);
    expect(await updated.text()).toBe("Second");
    expect(updated.headers.get("last-modified")).toBeNull();
  });
});
