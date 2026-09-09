describe("dashboard site settings save", function () {
  const Blog = require("models/blog");

  global.test.site({ login: true });

  it("does not pass protected request fields to Blog.set", async function () {
    spyOn(Blog, "set").and.callThrough();

    await this.submit(`/sites/${this.blog.handle}/settings/date`, {
      dateFormat: "MM/DD/YYYY",
      id: "attacker-controlled-id",
      owner: "attacker-controlled-owner",
      cacheID: "12345",
    });

    expect(Blog.set).toHaveBeenCalled();

    const updates = Blog.set.calls.mostRecent().args[1];

    expect(updates.dateFormat).toBe("MM/DD/YYYY");
    expect(Object.keys(updates)).not.toContain("id");
    expect(Object.keys(updates)).not.toContain("owner");
    expect(Object.keys(updates)).not.toContain("cacheID");
  });

  // Regression: saving a plugin option (e.g. typeset) from a settings
  // sub-page used to bounce the user out to the site homepage because the
  // form omitted the `redirect` field and save/finish.js fell back to a
  // router-relative req.path of "/".
  ["settings", "settings/images", "settings/links"].forEach((page) => {
    it(
      `keeps the redirect on /${page} pointed back at itself`,
      async function () {
        const $ = await this.parse(`/sites/${this.blog.handle}/${page}`);
        const redirect = $('input[name="redirect"]').attr("value");
        expect(redirect).toBe(`/sites/${this.blog.handle}/${page}`);
      },
      30000
    );
  });

  it(
    "does not redirect to the homepage when the form omits a redirect field",
    async function () {
      const res = await this.submit(`/sites/${this.blog.handle}/settings`, {
        "plugins.typeset.options.punctuation": "on",
      });

      const path = new URL(res.url).pathname;

      expect(path).not.toBe("/");
      expect(path.startsWith(`/sites/${this.blog.handle}`)).toBe(true);
    },
    30000
  );
});
