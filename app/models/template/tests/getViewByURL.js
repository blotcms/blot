describe("template", function () {
  require("./setup")({ createTemplate: true });

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
});
