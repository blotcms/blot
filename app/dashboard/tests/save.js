describe("dashboard site settings save", function () {
  const Blog = require("models/blog");

  global.test.site({ login: true });

  it("does not pass protected request fields to Blog.set", async function () {
    spyOn(Blog, "set").and.callThrough();

    await this.submit(`/sites/${this.blog.handle}/settings/posts`, {
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
  ["settings/posts", "settings/redirects", "settings/services"].forEach(
    (page) => {
      it(`keeps the redirect on /${page} pointed back at itself`, async function () {
        const $ = await this.parse(`/sites/${this.blog.handle}/${page}`);
        const redirect = $('input[name="redirect"]').attr("value");
        expect(redirect).toBe(`/sites/${this.blog.handle}/${page}`);
      }, 30000);
    }
  );

  // The resave is queued in Redis (sync/pendingRebuilds), so a deploy which
  // kills the process running it doesn't leave the blog half saved
  it("queues a resave of every entry when the link format changes", async function () {
    const pendingRebuilds = require("sync/pendingRebuilds");
    const linkFormat = require("dashboard/site/link-format");

    spyOn(pendingRebuilds, "request").and.returnValue(Promise.resolve());

    // The links page has the shared settings form first, which this.submit
    // would post to instead, so the route's handler is called directly
    const res = {
      locals: { base: "/sites/" + this.blog.handle },
      message: jasmine.createSpy("message"),
    };

    await linkFormat.save(
      {
        body: { format: "", custom: "/archive/{{slug}}" },
        blog: this.blog,
      },
      res
    );

    expect(res.message).toHaveBeenCalledWith(
      "/sites/" + this.blog.handle + "/settings/posts",
      "Saved changes to link format"
    );
    expect(pendingRebuilds.request).toHaveBeenCalledWith(this.blog.id, [
      "resave",
    ]);
  }, 30000);

  it("does not redirect to the homepage when the form omits a redirect field", async function () {
    const res = await this.submit(`/sites/${this.blog.handle}/settings/posts`, {
      "plugins.typeset.options.punctuation": "on",
    });

    const path = new URL(res.url).pathname;

    expect(path).not.toBe("/");
    expect(path.startsWith(`/sites/${this.blog.handle}`)).toBe(true);
  }, 30000);
});
