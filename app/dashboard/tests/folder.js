describe("folder", function () {
  global.test.site({ login: true });

  const testCases = [
    // Basic names
    "a.txt", // Simple file
    "a/normal/file.txt", // Simple nested file

    // Whitespace edge cases
    " leading-space", // Leading space
    "trailing-space ", // Trailing space
    "multiple    spaces", // Multiple consecutive spaces
    "tab\ttab", // Tab character
    "space\t\ttab", // Mixed spaces and tabs
    "new\nline", // Newline character

    // Common special characters
    "semi;colon", // Semicolon
    "asterisk*star", // Asterisk
    'quote"marks"', // Double quotes
    "single'quote", // Single quote
    "pipe|pipe", // Pipe
    "question?mark", // Question mark
    "<>anglebrackets", // Angle brackets
    "[brackets]", // Square brackets
    "{curly}", // Curly braces
    "(parentheses)", // Parentheses
    "colon:colon", // Colon
    "dash-start", // Dash at start
    "end-dash-", // Dash at end
    "_underscore_", // Underscore
    "@at-sign", // At sign
    "#hashtag", // Hashtag
    "!exclaim!", // Exclamation mark
    "$dollar$", // Dollar sign
    "percent%", // Percent sign
    "caret^", // Caret
    "tilde~", // Tilde

    // Windows reserved words and device files
    "CON", // Reserved device name (Windows)
    "nul", // Reserved device name (Windows)

    // Special/encoded characters and percent-encoding
    "20% luck/30% skill.txt/99% will.txt", // Percent sign and nested path

    // File and folder names with dots and slashes
    "app/bar.txt", // Slash in path
    "slash/forward", // Forward slash
    "slash\\backward", // Backslash
    "file.name.with.dots", // Multiple dots

    // Accented and Unicode
    "tést", // Accented character
    "accentèd", // Another accented
    "𝓤𝓷𝓲𝓬𝓸𝓭𝓮", // Unicode fancy letters

    // Emoji and symbols
    "emoji-💾", // Emoji in name
    "emoji/文件夹/😀/файл", // Emoji + CJK + Cyrillic (nested)

    // Long names
    "A_very_very_very_very_very_very_very_very_very_very_long_folder_name", // Long folder name
    "A_very_very_very_very_very_very_very_very_very_very_long_folder_name/UPPERCASE", // Nested long folder

    // Mixed case and numeric
    "foo bar/space tab.txt", // Space in path
    "foo bar/space\t\ttab", // Space + tab in path
    "123456", // Numeric name
    "UPPERCASE", // All uppercase
    "MiXeDcAsE", // Mixed case

    // [Empty] and duplicate
    "[empty]", // Literal "[empty]"
    "duplicate", // Simple duplicate test

    // Nested and complex paths
    "tilde~/[empty]", // Tilde + nested [empty]
    "test/emoji-💾/文件夹", // Mixed emoji and CJK in path
    "CON/nul/pipe|pipe", // Reserved device names in path
    "slash/forward/question?mark", // Special chars in nested path
    "nested1/nested2/nested3/nested4", // Deep nesting
    "emoji-💾/20% luck/[brackets]", // Emoji + percent + brackets
    "tab\ttab/new\nline", // Tab and newline in path

    // Non-Latin alphabets (single-language)
    "русский/папка/файл", // Cyrillic (Russian)
    "Ελληνικά/φάκελος/αρχείο", // Greek
    "עברית/תיקיה/קובץ", // Hebrew (RTL)
    "العربية/مجلد/ملف", // Arabic (RTL)
    "中文/文件夹/文件", // Chinese (Simplified)
    "日本語/フォルダ/ファイル", // Japanese (Kana/Kanji)
    "한국어/폴더/파일", // Korean (Hangul)
    "हिन्दी/फ़ोल्डर/फ़ाइल", // Hindi (Devanagari)
    "ไทย/โฟลเดอร์/ไฟล์", // Thai

    // Other scripts
    "ગુજરાતી/ફોલ્ડર/ફાઇલ", // Gujarati
    "ελληνικά/έγγραφα/αρχείο", // Greek (with accents)
    "বাংলা/ফোল্ডার/ফাইল", // Bengali
    "தமிழ்/கோப்பு/அடைவு", // Tamil
    "አማርኛ/ፎልደር/ፋይል", // Amharic (Ethiopic)
    "ⲁⲛⲅⲗⲓⲕⲟⲛ/ⲫⲩⲗⲗⲟⲛ/ⲫⲁⲓⲗ", // Coptic

    // Mixed language and special character cases
    "अंग्रेज़ी/😀/folder", // Hindi + Emoji + English
    "العربية/tilde~/مجلد", // Arabic + tilde + English
    "русский/semi;colon", // Cyrillic + semicolon
    "Ελληνικά/trailing-space ", // Greek + trailing space
    "한국어/😀/emoji", // Korean + emoji
    "中文/空 格/😀", // Chinese + space + emoji
    "עברית/מסמך/😀", // Hebrew + emoji
    "日本語/ファイル/💾", // Japanese + emoji
  ];

  for (const path of testCases) {
    it(`handles path ${path}`, async function () {
      await this.write({ path, content: "test content here" });

      let $ = await this.parse(`/sites/${this.blog.handle}`);
      const pathComponents = path.split("/").filter(Boolean);

      // Navigate through each directory in the path
      for (const [index, component] of pathComponents.entries()) {
        const link = findElementByText(".directory-list a", component, $);
        if (!link) {
          throw new Error(
            `Link not found for "${component}" in path "${path}"`
          );
        }

        $ = await this.parse(link.attr("href"));

        // Handle the final component (file)
        if (index === pathComponents.length - 1) {
          const fileHeader = findElementByText("h1", component, $);
          if (!fileHeader) {
            throw new Error(`Header not found for file "${component}"`);
          }

          const downloadLink = $("a:contains('Download file')").attr("href");
          if (!downloadLink) {
            throw new Error("Download link not found");
          }

          const fileContent = await this.text(downloadLink);
          expect(fileContent).toBe("test content here");
        }
      }
    });
  }

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

  function findElementByText(selector, text, $) {
    return $(selector)
      .filter(function () {
        return $(this).text().includes(text);
      })
      .first();
  }
});
