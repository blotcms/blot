describe("dashboard posts view", function () {
  global.test.site({ login: true });

  it("groups posts, drafts and scheduled items with counts", async function () {
    await this.blog.write({ path: "/first.txt", content: "Title: First\n\nBody" });
    await this.blog.write({
      path: "/second.txt",
      content: "Title: Second\nDraft: yes\n\nBody",
    });
    await this.blog.rebuild();

    const $all = await this.parse(`/sites/${this.blog.handle}/posts`);
    const groups = $all(".site-dashboard-post-group")
      .map((i, el) => $all(el).attr("data-post-group"))
      .get();

    expect(groups).toContain("posts");
    expect(groups).toContain("drafts");
    expect($all(".site-dashboard-post-list").text()).toContain("First");

    const $drafts = await this.parse(`/sites/${this.blog.handle}/posts/drafts`);
    expect($drafts(".site-dashboard-post-group").length).toBe(1);
    expect($drafts(".site-dashboard-post-list").text()).toContain("Second");
  });

  it("explains an empty filter", async function () {
    const $ = await this.parse(`/sites/${this.blog.handle}/posts/scheduled`);

    expect($(".site-dashboard-empty").text()).toContain("No scheduled yet.");
  });

  it("redirects unknown filters to all posts", async function () {
    const $ = await this.parse(`/sites/${this.blog.handle}/posts/nonsense`);

    expect($("#site-dashboard-posts").attr("hidden")).toBeUndefined();
  });

  it("shows the recent activity view with or without a trailing slash", async function () {
    for (const path of ["recents", "recents/"]) {
      const $ = await this.parse(`/sites/${this.blog.handle}/${path}`);

      expect($("#site-dashboard-recent").attr("hidden")).toBeUndefined();
      expect($("#site-dashboard-folder").attr("hidden")).toBeDefined();
    }
  });

  it("follows the old title and domain paths to settings", async function () {
    const title = await this.text(`/sites/${this.blog.handle}/title`);
    expect(title).toMatch(this.blog.title);

    const domain = await this.text(`/sites/${this.blog.handle}/domain`);
    expect(domain).toMatch("domain");
  });
});
