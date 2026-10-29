describe("Blot dashboard settings", function () {
  const fs = require("fs-extra");
  const browser = require("./util/browser");

  // Removing a local-client blog waits for the watcher sync's folder lock.
  // During process startup a contended lock retries after 11s, so teardown
  // can legitimately exceed Jasmine's default 5s even after a quick sync.
  global.test.timeout(20 * 1000);

  global.test.site({ login: true });

  it("lets you update the title of a site", async function () {
    const page = browser(this);
    const handle = this.blog.handle;

    await page.goto("/sites");
    await page.click('a[href^="/sites/"]');

    // click on the title settings link
    await page.click('a[href="/sites/' + handle + '/settings/title"]');

    // enter a new title and submit the form
    page.type("input[name=title]", "New title");
    await page.click("[type=submit]");

    // go back to the dashboard
    await page.click('a[href="/sites/' + handle + '"]');

    // the <title> of the page should be "New title - Blot"
    expect(page.title).toEqual("New title - Blot");
  });

  it("lets you sync the folder using local folder", async function () {
    const page = browser(this);
    const handle = this.blog.handle;

    // go to the site overview page
    await page.goto("/sites");
    await page.click('a[href="/sites/' + handle + '"]');

    // go to the client settings page
    await page.click('a[href^="/sites/' + handle + '/client"]');

    // click on the button for the local folder client
    await page.click("button[name=client][value=local]");

    // go to the site overview page
    await page.click('a[href="/sites/' + handle + '"]');

    // verify the client link now says 'Local folder'
    const client = page.$('a[href^="/sites/' + handle + '/client"] span.center');

    expect(client.text().replace(/\s+/g, " ").trim()).toMatch(/^Local folder/);

    // add some files to the blog's folder
    await fs.outputFile(this.blogDirectory + "/test.txt", "test");

    // refresh the site overview page
    await page.goto("/sites/" + handle);

    // verify that the new file is listed in the folder
    expect(page.$("table.directory-list").text()).toContain("test.txt");
  });
});
