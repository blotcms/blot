describe("active property", function () {
  require("blog/tests/util/setup")();

  function active(url, local) {
    var helper;

    require("../active")({ url: url }, {}, function (err, value) {
      expect(err).toBeNull();
      helper = value;
    });

    return helper.call(local);
  }

  it("compares encoded tag slugs without treating encoded slashes as separators", function () {
    expect(active("/tagged/design%2Fui", { slug: "design%2Fui" })).toEqual(
      "active"
    );
    expect(active("/tagged/design/ui", { slug: "design%2Fui" })).toEqual("");
  });

  it("retains active matching for ordinary, spaced, and accented tag slugs", function () {
    expect(active("/tagged/design", { slug: "design" })).toEqual("active");
    expect(active("/tagged/web%20design", { slug: "web%20design" })).toEqual(
      "active"
    );
    expect(active("/tagged/caf%C3%A9", { slug: "caf%C3%A9" })).toEqual(
      "active"
    );
  });

  it("does not conflate an encoded query delimiter in a slug with a real query string", function () {
    expect(active("/tagged/foo%3Fbar", { slug: "foo%3Fbar" })).toEqual(
      "active"
    );
    expect(active("/tagged/foo?bar", { slug: "foo%3Fbar" })).toEqual("");
  });

  it("retains complete local URL matching and rejects malformed escapes", function () {
    expect(active("/caf%C3%A9", { url: "/café" })).toEqual("active");
    expect(active("/tagged/bad%escape", { slug: "bad%escape" })).toBe(false);
  });

  it("renders an 'active' property for each entry", async function () {
    await this.write({ path: "/1.txt", content: "Link: /1\n\nA" });
    await this.write({ path: "/2.txt", content: "Link: /2\n\nB" });

    await this.template({
      "entry.html": "{{#posts}}{{name}}:{{active}},{{/posts}}",
    });

    const res = await this.get(`/1`);

    expect((await res.text()).trim().toLowerCase()).toEqual(
      "2.txt:,1.txt:active,"
    );

    const res2 = await this.get(`/2`);

    expect((await res2.text()).trim().toLowerCase()).toEqual(
      "2.txt:active,1.txt:,"
    );
  });

  it("renders an 'active' property for template local arrays, based on the url", async function () {
    await this.template(
      {
        "foo.html": "{{#items}}{{label}}:{{active}},{{/items}}",
      },
      {
        locals: {
          items: [
            { label: "1", url: "/foo.html" },
            { label: "2", url: "/2" },
          ],
        },
      }
    );

    const res = await this.get(`/foo.html`);

    expect((await res.text()).trim().toLowerCase()).toEqual("1:active,2:,");
  });

  it("renders an 'active' property for the blog's menu", async function () {
    await this.blog.update({
      menu: [
        { id: "1", label: "Archives", url: "/archives" },
        { id: "2", label: "Feed", url: "/feed" },
      ],
    });

    await this.template(
      {
        "archives.html": "{{#menu}}{{label}}:{{active}},{{/menu}}",
      },
      {
        views: {
          "archives.html": {
            url: "/archives",
          },
        },
      }
    );

    const res = await this.get(`/archives`);

    expect((await res.text()).trim().toLowerCase()).toEqual(
      "archives:active,feed:,"
    );
  });
});
