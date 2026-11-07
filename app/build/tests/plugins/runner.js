const { convert, list } = require("../../plugins");

describe("plugin runner", function () {
  const blogBase = {
    domain: "example.com",
    handle: "plugin-runner",
    id: "plugin-runner-test",
  };

  async function runPlugins(plugins, contents) {
    const [html, dependencies] = await convert(
      { ...blogBase, plugins },
      "/post.html",
      contents
    );
    return { html, dependencies };
  }

  it("collects newDependencies from plugin results", async function () {
    const plugins = { wikilinks: { enabled: true, options: {} } };
    const contents = '<a href="target" title="wikilink">wikilink</a>';

    const { dependencies } = await runPlugins(plugins, contents);

    expect(dependencies).toContain("/target");
  });

  it("supports legacy wikilink title markers by migrating to class", async function () {
    const plugins = { wikilinks: { enabled: true, options: {} } };
    const contents = '<a href="target" title="wikilink">wikilink</a>';

    const { html, dependencies } = await runPlugins(plugins, contents);

    expect(html).toContain('class="wikilink"');
    expect(html).not.toContain('title="wikilink"');
    expect(dependencies).toContain("/target");
  });

  it("does not treat user-authored .wikilink classes as generated markers", async function () {
    const plugins = { wikilinks: { enabled: true, options: {} } };
    const contents = '<a href="target" class="wikilink">wikilink</a>';

    const { html, dependencies } = await runPlugins(plugins, contents);

    expect(html).toContain('<a href="target" class="wikilink">wikilink</a>');
    expect(dependencies.length).toBe(0);
  });

  it("leaves unsupported legacy title markers unchanged", async function () {
    const plugins = { wikilinks: { enabled: true, options: {} } };
    const contents = '<span title="wikilink">tooltip</span>';

    const { html, dependencies } = await runPlugins(plugins, contents);

    expect(html).toContain('<span title="wikilink">tooltip</span>');
    expect(dependencies.length).toBe(0);
  });

  it("ignores plugins that return no result", async function () {
    const plugins = { autoImage: { enabled: true, options: {} } };
    const contents =
      "<p><a href='https://elsewhere.test/image.jpg'>https://elsewhere.test/image.jpg</a></p>";

    const { dependencies } = await runPlugins(plugins, contents);

    expect(dependencies.length).toBe(0);
  });

  it("skips a plugin whose render rejects and runs the ones after it", async function () {
    const plugins = {
      titlecase: { enabled: true, options: {} },
      mediaPreload: { enabled: true, options: {} },
    };
    const contents = "<h1>a title</h1><audio></audio>";

    spyOn(list.titlecase, "render").and.callFake(async () => {
      throw new Error("plugin failed");
    });

    const { html } = await runPlugins(plugins, contents);

    expect(html).toContain("<h1>a title</h1>");
    expect(html).toContain('preload="metadata"');
  });

  it("collects dependencies from a plugin that resolves to an array", async function () {
    const plugins = { titlecase: { enabled: true, options: {} } };

    spyOn(list.titlecase, "render").and.callFake(async () => ["/one.txt"]);

    const { dependencies } = await runPlugins(plugins, "<p>text</p>");

    expect(dependencies).toEqual(["/one.txt"]);
  });

  it("passes cheerio and the plugin's options to render", async function () {
    const plugins = {
      titlecase: { enabled: true, options: { custom: "value" } },
    };

    const render = spyOn(list.titlecase, "render").and.callFake(async () => {});

    await runPlugins(plugins, "<p>text</p>");

    expect(render.calls.count()).toEqual(1);
    expect(render.calls.argsFor(0).length).toEqual(2);
    expect(typeof render.calls.argsFor(0)[0]).toEqual("function");
    expect(render.calls.argsFor(0)[1].custom).toEqual("value");
    expect(render.calls.argsFor(0)[1].blogID).toEqual("plugin-runner-test");
  });
});
