describe("publishing settings", function () {
  const Blog = require("models/blog");

  global.test.site({ login: true });

  it("saves image metadata preferences", async function () {
    const publishingPage = await this.text(
      `/sites/${this.blog.handle}/settings/images`
    );

    expect(publishingPage).toMatch("Exif data");

    await this.submit(`/sites/${this.blog.handle}/settings/images`, {
      imageExif: "off",
    });

    const blogAfterOff = await Blog.get({ id: this.blog.id });

    expect(blogAfterOff.imageExif).toBe("off");
    expect(blogAfterOff.isImageExifOff).toBe(true);

    const updatedPublishingPage = await this.text(
      `/sites/${this.blog.handle}/settings/images`
    );

    expect(updatedPublishingPage).toMatch("Exif data");

    await this.submit(`/sites/${this.blog.handle}/settings/images`, {
      imageExif: "full",
    });

    const blogAfterFull = await Blog.get({ id: this.blog.id });
    expect(blogAfterFull.imageExif).toBe("full");
    expect(blogAfterFull.isImageExifFull).toBe(true);
  });
});
