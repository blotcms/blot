describe("folder (pagination and sorting)", function () {
  global.test.site({ login: true });

  it("shows the post size warning on the directory and file pages", async function () {
    const { MARKDOWN } = require("build/converters/post-source-size");
    await this.write({
      path: "oversized.md",
      content: Buffer.alloc(MARKDOWN.bytes + 1, 32),
    });
    await this.blog.rebuild();

    const directory = await this.parse(`/sites/${this.blog.handle}`);
    expect(directory.text()).toContain(
      `Exceeds ${MARKDOWN.label} post limit`
    );

    const file = await this.parse(
      directory("a:contains('oversized.md')").attr("href")
    );
    expect(file.text()).toContain(
      `exceeds the ${MARKDOWN.label} post size limit`
    );
    expect(file.text()).toContain("remains available as a file");
    expect(file.text()).toContain("cannot become a post or page until it is reduced");
  });

  describe("pagination", function () {
    // Sorted names so we can predict which files land on which page.
    const names = ["p01.txt", "p02.txt", "p03.txt", "p04.txt", "p05.txt"];

    beforeEach(async function () {
      for (const path of names) {
        await this.write({ path, content: "content of " + path });
      }
    });

    const rowNames = ($) =>
      $(".directory-list tbody tr.directory-row .truncate")
        .map(function () {
          return $(this).text().trim();
        })
        .get();

    it("splits a large folder into pages", async function () {
      const $ = await this.parse(`/sites/${this.blog.handle}?pageSize=2`);

      expect(rowNames($)).toEqual(["p01.txt", "p02.txt"]);
      expect($(".directory-pagination").length).toEqual(1);
      expect($(".directory-pagination__status").text().replace(/\s+/g, " ").trim())
        .toContain("page 1 of 3");

      // No "Previous" link on the first page, but a "Next" link.
      expect($("a.directory-pagination__link[rel='prev']").length).toEqual(0);
      expect($("a.directory-pagination__link[rel='next']").length).toEqual(1);
    });

    it("shows the requested page", async function () {
      const $ = await this.parse(
        `/sites/${this.blog.handle}?pageSize=2&page=2`
      );

      expect(rowNames($)).toEqual(["p03.txt", "p04.txt"]);
      expect($("a.directory-pagination__link[rel='prev']").length).toEqual(1);
      expect($("a.directory-pagination__link[rel='next']").length).toEqual(1);
    });

    it("shows a partial final page and disables Next", async function () {
      const $ = await this.parse(
        `/sites/${this.blog.handle}?pageSize=2&page=3`
      );

      expect(rowNames($)).toEqual(["p05.txt"]);
      expect($("a.directory-pagination__link[rel='next']").length).toEqual(0);
      expect($(".directory-pagination__status").text()).toContain("5 of 5");
    });

    it("clamps an out-of-range page to the last page", async function () {
      const $ = await this.parse(
        `/sites/${this.blog.handle}?pageSize=2&page=999`
      );

      expect(rowNames($)).toEqual(["p05.txt"]);
      expect($(".directory-pagination__status").text().replace(/\s+/g, " "))
        .toContain("page 3 of 3");
    });

    it("does not paginate a folder that fits on one page", async function () {
      const $ = await this.parse(`/sites/${this.blog.handle}`);

      expect(rowNames($)).toEqual(names);
      expect($(".directory-pagination").length).toEqual(0);
    });

    it("still lists a folder when an entry disappears mid-read", async function () {
      // A dangling symlink makes fs.stat throw ENOENT, the same failure mode
      // as a file removed between readdir and stat while a big folder syncs.
      // Previously this made the whole folder render as empty.
      const fs = require("fs-extra");
      const { join } = require("path");
      await fs.symlink(
        join(this.blogDirectory, "does-not-exist.txt"),
        join(this.blogDirectory, "dangling.txt")
      );

      const $ = await this.parse(`/sites/${this.blog.handle}`);

      expect(rowNames($)).toEqual(names);
    });

    it("backfills a page when an entry on it has vanished", async function () {
      // "p00.txt" sorts before the real files and would be the first row of
      // page one; a dangling symlink makes it unstattable. The page should
      // still show a full pageSize of real files by pulling the next name in.
      const fs = require("fs-extra");
      const { join } = require("path");
      await fs.symlink(
        join(this.blogDirectory, "does-not-exist.txt"),
        join(this.blogDirectory, "p00.txt")
      );

      const $ = await this.parse(
        `/sites/${this.blog.handle}?pageSize=2&page=1`
      );

      expect(rowNames($)).toEqual(["p01.txt", "p02.txt"]);
      expect($("a.directory-pagination__link[rel='next']").length).toEqual(1);
    });

    it("caps the page size at the default", async function () {
      const getContents = require("dashboard/site/folder/folder");
      const { pagination } = await getContents(
        this.blog,
        "/",
        { pageSize: 10 * getContents.DEFAULT_PAGE_SIZE }
      );
      expect(pagination.pageSize).toEqual(getContents.DEFAULT_PAGE_SIZE);
    });

    it("sorts by name descending on the server", async function () {
      const $ = await this.parse(
        `/sites/${this.blog.handle}?pageSize=2&sort=name&order=desc`
      );
      expect(rowNames($)).toEqual(["p05.txt", "p04.txt"]);
    });

    it("orders names naturally across a page boundary", async function () {
      // Unpadded numbers: a plain lexicographic sort would put "file10"
      // before "file2" and split the pages there.
      for (const path of ["file1", "file2", "file10", "file20"]) {
        await this.write({ path, content: path });
      }

      const page1 = await this.parse(
        `/sites/${this.blog.handle}?pageSize=2&sort=name`
      );
      const page2 = await this.parse(
        `/sites/${this.blog.handle}?pageSize=2&sort=name&page=2`
      );

      expect(rowNames(page1)).toEqual(["file1", "file2"]);
      expect(rowNames(page2)).toEqual(["file10", "file20"]);
    });
  });

  describe("server-side sorting", function () {
    const getContents = () => require("dashboard/site/folder/folder");

    const names = (result) => result.contents.map((stat) => stat.name);

    beforeEach(async function () {
      const fs = require("fs-extra");
      const { join } = require("path");

      // Distinct sizes and modified times so every sort has one right answer.
      await this.write({ path: "small.txt", content: "x".repeat(10) });
      await this.write({ path: "large.txt", content: "x".repeat(4000) });
      await this.write({ path: "medium.txt", content: "x".repeat(500) });

      const t = (iso) => new Date(iso);
      await fs.utimes(join(this.blogDirectory, "small.txt"), t("2021-01-01"), t("2021-01-01"));
      await fs.utimes(join(this.blogDirectory, "medium.txt"), t("2022-06-01"), t("2022-06-01"));
      await fs.utimes(join(this.blogDirectory, "large.txt"), t("2023-12-01"), t("2023-12-01"));
    });

    it("orders by size, largest first", async function () {
      const result = await getContents()(this.blog, "/", {
        sort: "size",
        order: "desc",
      });
      expect(names(result)).toEqual(["large.txt", "medium.txt", "small.txt"]);
    });

    it("orders by size, smallest first", async function () {
      const result = await getContents()(this.blog, "/", {
        sort: "size",
        order: "asc",
      });
      expect(names(result)).toEqual(["small.txt", "medium.txt", "large.txt"]);
    });

    it("orders by modified time, newest first", async function () {
      const result = await getContents()(this.blog, "/", {
        sort: "modified",
        order: "desc",
      });
      expect(names(result)).toEqual(["large.txt", "medium.txt", "small.txt"]);
    });

    it("paginates within a server-side sort", async function () {
      const page1 = await getContents()(this.blog, "/", {
        sort: "size",
        order: "asc",
        pageSize: 1,
        page: 1,
      });
      const page2 = await getContents()(this.blog, "/", {
        sort: "size",
        order: "asc",
        pageSize: 1,
        page: 2,
      });
      expect(names(page1)).toEqual(["small.txt"]);
      expect(names(page2)).toEqual(["medium.txt"]);
      expect(page1.pagination.hasNext).toBe(true);
    });

    it("falls back to name sort for an unknown sort key", async function () {
      const result = await getContents()(this.blog, "/", { sort: "banana" });
      expect(result.pagination.sort).toEqual("name");
      expect(names(result)).toEqual(["large.txt", "medium.txt", "small.txt"]);
    });
  });
});
