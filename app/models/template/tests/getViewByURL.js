describe("template", function () {
  const client = require("models/client");
  const key = require("../key");

  require("./setup")({ createTemplate: true });

  // A view stored before URL patterns: only the exact-URL key points to it
  beforeEach(function () {
    this.setLegacyURL = (url, viewName) =>
      client.set(key.url(this.template.id, url), viewName);
  });

  it("gets a view from a URL", async function () {
    await this.setView({
      name: "apple.html",
      url: ["/page/:page", "/"],
    });

    const { viewName: viewName1, params: params1 } =
      await this.getViewByURL("/page/1");

    expect(viewName1).toEqual("apple.html");
    expect(params1).toEqual({ page: "1" });

    const { viewName: viewName2, params: params2 } =
      await this.getViewByURL("/");

    expect(viewName2).toEqual("apple.html");
    expect(params2).toEqual({});

    const { viewName: viewName3, params: params3 } =
      await this.getViewByURL("/page/2");

    expect(viewName3).toEqual("apple.html");
    expect(params3).toEqual({ page: "2" });
  });

  it("gets a view from a URL with a query string", async function () {
    const view = {
      name: "apple.html",
      url: ["/apple"],
    };

    await this.setView(view);

    const { viewName, params, query } =
      await this.getViewByURL("/apple?foo=bar");

    expect(viewName).toEqual(view.name);
    expect(params).toEqual({});
    expect(query).toEqual({ foo: "bar" });
  });

  it("gets a view from a URL with a trailing slash", async function () {
    const view = {
      name: "apple.html",
      url: ["/apple"],
    };

    await this.setView(view);
    const { viewName } = await this.getViewByURL("/apple/");

    expect(viewName).toEqual(view.name);
  });

  it("gets a view whose route contains a trailing slash from a URL without", async function () {
    const view = {
      name: "apple.html",
      url: ["/apple/"],
    };

    await this.setView(view);
    const { viewName } = await this.getViewByURL("/apple");

    expect(viewName).toEqual(view.name);
  });

  it("gets a view by multiple url", async function () {
    const view = {
      name: "page.html",
      url: ["/page/:page", "/"],
    };

    await this.setView(view);

    const { viewName: rootViewName } = await this.getViewByURL("/");
    expect(rootViewName).toEqual(view.name);

    const { viewName: pageViewName } = await this.getViewByURL("/page/2");
    expect(pageViewName).toEqual(view.name);
  });

  it("gets a view by a lowercase URL without slash", async function () {
    const url = "/Apple";
    const view = {
      name: "apple.html",
      url: [url],
    };

    await this.setView(view);
    const { viewName } = await this.getViewByURL("apple");

    expect(viewName).toEqual(view.name);
  });

  it("orders views alphabetically if multiple match", async function () {
    await this.setView({
      name: "a.html",
      url: "/apple",
    });
    await this.setView({
      name: "b.html",
      url: "/apple",
    });
    await this.setView({
      name: "c.html",
      url: "/apple",
    });

    const { viewName: view1 } = await this.getViewByURL("/apple");

    expect(view1).toEqual("a.html");

    await this.dropView("a.html");

    const { viewName: view2 } = await this.getViewByURL("/apple");

    expect(view2).toEqual("b.html");

    await this.dropView("b.html");

    const { viewName: view3 } = await this.getViewByURL("/apple");

    expect(view3).toEqual("c.html");
  });

  it("gets a view by an uppercase URL", async function () {
    const url = "/apple";
    const view = {
      name: "apple.html",
      url: [url],
    };

    await this.setView(view);
    const { viewName } = await this.getViewByURL("/Apple");

    expect(viewName).toEqual(view.name);
  });

  it("gets a view with accented characters", async function () {
    const url = "/ápple";
    const view = {
      name: "apple.html",
      url: [url],
    };

    await this.setView(view);
    const { viewName } = await this.getViewByURL("/ápple");

    expect(viewName).toEqual(view.name);
  });

  it("returns an error for a non-existent URL", async function () {
    try {
      await this.getViewByURL("");
    } catch (err) {
      expect(err instanceof Error).toBe(true);
    }
  });

  describe("route priority", function () {
    it("routes an exact URL before a parameter pattern of a view that sorts earlier", async function () {
      await this.setView({ name: "entry.html", url: ["/:slug"] });
      await this.setView({ name: "style.css", url: ["/style.css"] });

      const style = await this.getViewByURL("/style.css");
      expect(style.viewName).toEqual("style.css");
      expect(style.pattern).toEqual("/style.css");

      const hello = await this.getViewByURL("/hello");
      expect(hello.viewName).toEqual("entry.html");
      expect(hello.params).toEqual({ slug: "hello" });
      expect(hello.pattern).toEqual("/:slug");
    });

    it("ranks each pattern, not each view", async function () {
      await this.setView({
        name: "archives.html",
        url: ["/archives", "/archives/page/:page"],
      });
      await this.setView({ name: "a.html", url: ["/:slug"] });

      expect((await this.getViewByURL("/archives")).viewName).toEqual(
        "archives.html"
      );
      expect((await this.getViewByURL("/archives/page/2")).params).toEqual({
        page: "2",
      });
    });

    it("uses an exact-URL key whose view has no patterns before a parameter pattern", async function () {
      await this.setView({ name: "entry.html", url: ["/:slug"] });
      await this.setLegacyURL("/old", "old.html");

      const result = await this.getViewByURL("/old");
      expect(result.viewName).toEqual("old.html");
      expect(result.pattern).toBe(null);
      expect(result.params).toBe(null);

      expect((await this.getViewByURL("/new")).viewName).toEqual("entry.html");
    });

    it("ignores an exact-URL key whose view has patterns", async function () {
      await this.setView({ name: "a.html", url: ["/:slug"] });
      await this.setView({ name: "b.html", url: ["/b/:id"] });
      // Points at b.html, which routes by its own patterns
      await this.setLegacyURL("/other", "b.html");

      expect((await this.getViewByURL("/other")).viewName).toEqual("a.html");
    });

    it("prefers an exact pattern to an exact-URL key for another view", async function () {
      await this.setView({ name: "ABOUT", url: ["/about"] });
      await this.setLegacyURL("/about", "about");

      expect((await this.getViewByURL("/about")).viewName).toEqual("ABOUT");
    });

    it("breaks a tie between exact patterns of views named in different case by view name", async function () {
      await this.setView({ name: "about", url: ["/about"] });
      await this.setView({ name: "ABOUT", url: ["/about"] });

      expect((await this.getViewByURL("/about")).viewName).toEqual(
        "about".localeCompare("ABOUT") < 0 ? "about" : "ABOUT"
      );
    });

    it("routes the pattern with more literal segments first", async function () {
      await this.setView({ name: "a.html", url: ["/tagged/:tag/:x"] });
      await this.setView({ name: "b.html", url: ["/tagged/:tag/page/:page"] });

      const result = await this.getViewByURL("/tagged/a/page/2");
      expect(result.viewName).toEqual("b.html");
      expect(result.params).toEqual({ tag: "a", page: "2" });
    });

    it("routes the pattern with more literal characters first when segments tie", async function () {
      await this.setView({ name: "a.html", url: ["/blog/:slug"] });
      await this.setView({ name: "b.html", url: ["/blogging/:slug"] });

      expect((await this.getViewByURL("/blogging/x")).viewName).toEqual(
        "b.html"
      );
    });

    it("routes a literal URL that isn't a valid pattern as an exact URL", async function () {
      await this.setView({ name: "about.html", url: "/about(me)" });
      await this.setView({ name: "entry.html", url: ["/:slug"] });

      const about = await this.getViewByURL("/about(me)");
      expect(about.viewName).toEqual("about.html");

      expect((await this.getViewByURL("/hello")).viewName).toEqual(
        "entry.html"
      );
    });

    it("routes wildcards last", async function () {
      await this.setView({ name: "a.html", url: ["/{*path}"] });
      await this.setView({ name: "b.html", url: ["/:slug"] });
      await this.setView({ name: "c.html", url: ["/archives"] });

      expect((await this.getViewByURL("/archives")).viewName).toEqual("c.html");
      expect((await this.getViewByURL("/hello")).viewName).toEqual("b.html");

      const deep = await this.getViewByURL("/a/b/c");
      expect(deep.viewName).toEqual("a.html");
      expect(deep.params).toEqual({ path: "a/b/c" });
    });

    it("routes the wildcard with the longer literal prefix first", async function () {
      await this.setView({ name: "a.html", url: ["/{*path}"] });
      await this.setView({ name: "b.html", url: ["/docs/{*path}"] });

      expect((await this.getViewByURL("/docs/x/y")).viewName).toEqual("b.html");
      expect((await this.getViewByURL("/other/x")).viewName).toEqual("a.html");
    });

    it("orders equal ranks by view name", async function () {
      await this.setView({ name: "b.html", url: ["/:slug"] });
      await this.setView({ name: "a.html", url: ["/:id"] });

      expect((await this.getViewByURL("/x")).viewName).toEqual("a.html");
    });

    it("does not route a stale exact-URL key stored without a leading slash", async function () {
      await this.setLegacyURL("stale", "stale.html");

      expect((await this.getViewByURL("/stale")).viewName).toBe(null);
    });
  });
});
