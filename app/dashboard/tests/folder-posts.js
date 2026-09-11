describe("folder posts in the dashboard", function () {
  global.test.site({ login: true });

  it("shows a checkmark on plus folders and lists source files", async function () {
    await this.blog.write({ path: "/album+/one.md", content: "# One" });
    await this.blog.write({ path: "/album+/two.md", content: "# Two" });
    await this.blog.rebuild();

    const $root = await this.parse(`/sites/${this.blog.handle}`);
    const folderLink = $root(".directory-list a")
      .filter(function () {
        return $root(this).text().includes("album+");
      })
      .first();

    expect(folderLink.length).toBe(1);
    expect(folderLink.find(".icon-folder-check").length).toBe(1);

    const $file = await this.parse(
      `/sites/${this.blog.handle}/folder/album+/one.md`
    );

    expect($file(".publishing-steps").text()).toContain(
      "File is part of a folder post"
    );

    // The folder post's source files are listed in a "Post files:" row.
    const $postFilesRow = $file("table.file-stat tr").filter(function () {
      return $file(this).find("td").first().text().trim() === "Post files:";
    });
    expect($postFilesRow.length).toBe(1);
    expect($postFilesRow.find(".folder-post-file-list").text()).toContain(
      "one.md"
    );
    expect($postFilesRow.find(".folder-post-file-list").text()).toContain(
      "two.md"
    );
    expect(
      $file(".folder-post-file.current .file-name").text()
    ).toContain("one.md");
  });

  it("builds folder posts whose names contain brackets", async function () {
    await this.blog.write({
      path: "/[Blog]+/hello.md",
      content: "# Hello from brackets",
    });
    await this.blog.rebuild();

    const $root = await this.parse(`/sites/${this.blog.handle}`);
    const folderLink = $root(".directory-list a")
      .filter(function () {
        return $root(this).text().includes("[Blog]+");
      })
      .first();

    expect(folderLink.length).toBe(1);
    expect(folderLink.find(".icon-folder-check").length).toBe(1);

    const href = folderLink.attr("href");
    expect(href).toBeDefined();

    // Opening the + folder shows the aggregated post view, not a directory
    // listing.
    const $folder = await this.parse(href);
    expect($folder(".folder-box.directory").length).toBe(0);
    expect($folder(".folder-post-box").length).toBe(1);
    expect($folder(".publishing-steps").text()).toContain(
      "Folder is a post"
    );

    const fileLink = $folder(".folder-post-source-list a")
      .filter(function () {
        return $folder(this).text().includes("hello.md");
      })
      .first();

    expect(fileLink.length).toBe(1);

    const $file = await this.parse(fileLink.attr("href"));
    expect($file(".publishing-steps").text()).toContain(
      "File is part of a folder post"
    );
    expect($file.text()).toContain("Hello from brackets");
  });

  it("does not badge unsupported files inside a + folder as entries", async function () {
    // Use a sub-folder of the + folder so a directory listing is still shown;
    // opening the + folder itself renders the aggregated post view.
    await this.blog.write({ path: "/album+/extras/one.md", content: "# One" });
    await this.blog.write({
      path: "/album+/extras/archive.zip",
      content: "not really a zip",
    });
    await this.blog.rebuild();

    const $folder = await this.parse(
      `/sites/${this.blog.handle}/folder/album+/extras`
    );

    const zipLink = $folder(".directory-list a")
      .filter(function () {
        return $folder(this).text().includes("archive.zip");
      })
      .first();
    expect(zipLink.length).toBe(1);
    expect(zipLink.find(".icon-file-check").length).toBe(0);
    expect(zipLink.hasClass("entry")).toBe(false);

    const mdLink = $folder(".directory-list a")
      .filter(function () {
        return $folder(this).text().includes("one.md");
      })
      .first();
    expect(mdLink.find(".icon-file-check").length).toBe(1);
  });

  it("shows the aggregated post view when opening a + folder", async function () {
    await this.blog.write({ path: "/story+/01 intro.md", content: "# Intro" });
    await this.blog.write({ path: "/story+/02 middle.md", content: "The middle." });
    await this.blog.write({ path: "/story+/03 end.md", content: "The end." });
    await this.blog.rebuild();

    const $folder = await this.parse(
      `/sites/${this.blog.handle}/folder/story+`
    );

    // Aggregated view, not the interactive directory listing.
    expect($folder(".folder-box.directory").length).toBe(0);
    expect($folder(".entry-info").length).toBe(1);
    expect($folder(".publishing-steps").text()).toContain(
      "Folder is a post"
    );

    // Source files link to their own dashboard pages, in order.
    const names = $folder(".folder-post-source-list .file-name")
      .map(function () {
        return $folder(this).text().trim();
      })
      .get();
    expect(names).toEqual(["01 intro.md", "02 middle.md", "03 end.md"]);

    const firstHref = $folder(".folder-post-source-list a").first().attr("href");
    expect(firstHref).toContain("/folder/story%2B/01%20intro.md");
  });

  it("truncates the source file list past ten files", async function () {
    for (let i = 1; i <= 13; i++) {
      const name = String(i).padStart(2, "0");
      await this.blog.write({
        path: `/big+/${name}.md`,
        content: `# Part ${i}`,
      });
    }
    await this.blog.rebuild();

    const $folder = await this.parse(`/sites/${this.blog.handle}/folder/big+`);

    // Ten visible, the rest behind a disclosure.
    expect(
      $folder(".folder-post-sources > .folder-post-source-list .folder-post-source").length
    ).toBe(10);
    expect($folder(".folder-post-more").length).toBe(1);
    expect($folder(".folder-post-more > summary").text()).toContain("13 files");
    expect($folder(".folder-post-more .folder-post-source").length).toBe(3);
  });

  it("does not treat an ordinary post containing data-file as a folder post", async function () {
    await this.blog.write({
      path: "/notes.html",
      content: '<h1>Notes</h1><pre data-file="example.js">code</pre>',
    });
    await this.blog.rebuild();

    const $file = await this.parse(
      `/sites/${this.blog.handle}/folder/notes.html`
    );

    expect($file(".publishing-steps").text()).toContain("File is a post");
    expect($file(".publishing-steps").text()).not.toContain("folder post");
    expect($file(".folder-post-file-list").length).toBe(0);
    expect($file("table.file-stat").text()).not.toContain("Post files:");
  });
});
