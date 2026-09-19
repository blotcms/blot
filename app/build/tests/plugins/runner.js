const { convert } = require("../../plugins");

describe("plugin runner", function () {
  const blogBase = {
    domain: "example.com",
    handle: "plugin-runner",
    id: "plugin-runner-test",
  };

  function runPlugins(plugins, contents) {
    return new Promise((resolve, reject) => {
      convert(
        { ...blogBase, plugins },
        "/post.html",
        contents,
        function (err, html, dependencies) {
          if (err) return reject(err);
          resolve({ html, dependencies });
        }
      );
    });
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
    const contents = "<p><a href='https://elsewhere.test/image.jpg'>https://elsewhere.test/image.jpg</a></p>";

    const { dependencies } = await runPlugins(plugins, contents);

    expect(dependencies.length).toBe(0);
  });
});
