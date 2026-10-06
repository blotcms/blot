describe("parseUploadedTemplate", function () {
  const parseUploadedTemplate = require("../save/parse-uploaded-template");
  const Template = require("models/template");
  const {
    UPLOAD_MAX_FILES,
    UPLOAD_MAX_RAW_FILES,
    UPLOAD_MAX_VIEW_BYTES,
    UPLOAD_FALLBACK_NAME,
  } = require("../save/constants");

  // Build the entry shape the route hands the parser
  const entry = (relativePath, contents = "") => ({
    relativePath,
    buffer: Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8"),
  });

  const parse = (entries, options) => parseUploadedTemplate(entries, options);

  const problemsFrom = (entries, options) => {
    try {
      parseUploadedTemplate(entries, options);
    } catch (err) {
      return err.problems;
    }

    return null;
  };

  const viewNamed = (result, name) =>
    result.views.find((view) => view.name === name);

  describe("folder shape", function () {
    it("strips a single wrapper directory", function () {
      const result = parse([
        entry("my-theme/index.html", "<h1>Hi</h1>"),
        entry("my-theme/style.css", "body{}"),
      ]);

      expect(result.views.map((v) => v.name).sort()).toEqual([
        "index.html",
        "style.css",
      ]);
      expect(result.name).toEqual("my-theme");
    });

    it("leaves loose files alone", function () {
      const result = parse([
        entry("index.html", "<h1>Hi</h1>"),
        entry("style.css", "body{}"),
      ]);

      expect(result.views.map((v) => v.name).sort()).toEqual([
        "index.html",
        "style.css",
      ]);
      expect(result.name).toEqual(UPLOAD_FALLBACK_NAME);
    });

    it("strips repeated wrapper directories", function () {
      const result = parse([
        entry("outer/inner/index.html", "<h1>Hi</h1>"),
        entry("outer/inner/style.css", "body{}"),
      ]);

      expect(result.views.map((v) => v.name).sort()).toEqual([
        "index.html",
        "style.css",
      ]);
      // The outermost directory is the one the user actually dropped
      expect(result.name).toEqual("outer");
    });

    it("does not strip when the files do not share a directory", function () {
      const problems = problemsFrom([
        entry("one/index.html", "<h1>Hi</h1>"),
        entry("two/style.css", "body{}"),
      ]);

      expect(problems.length).toEqual(2);
      expect(problems.every((p) => p.reason === "nested")).toBe(true);
    });

    it("rejects files left nested after stripping", function () {
      const problems = problemsFrom([
        entry("my-theme/index.html", "<h1>Hi</h1>"),
        entry("my-theme/partials/head.html", "<head></head>"),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].reason).toEqual("nested");
      expect(problems[0].path).toEqual("partials/head.html");
    });

    it("does not strip a directory down to nothing", function () {
      // A single nested file shares its directory with itself. Stripping is
      // still correct here — the user dropped one folder holding one file.
      const result = parse([entry("my-theme/index.html", "<h1>Hi</h1>")]);

      expect(result.views.map((v) => v.name)).toEqual(["index.html"]);
      expect(result.name).toEqual("my-theme");
    });
  });

  describe("paths", function () {
    it("rejects absolute paths", function () {
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry("/etc/passwd", "root"),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].reason).toEqual("invalid-path");
    });

    it("rejects windows absolute paths", function () {
      const problems = problemsFrom([entry("C:\\theme\\index.html", "<h1>Hi</h1>")]);

      expect(problems[0].reason).toEqual("invalid-path");
    });

    it("rejects paths which navigate upwards", function () {
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry("../escape.html", "nope"),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].reason).toEqual("invalid-path");
    });

    it("rejects names containing control characters", function () {
      const problems = problemsFrom([
        entry(`index${String.fromCharCode(0)}.html`, "<h1>Hi</h1>"),
      ]);

      expect(problems[0].reason).toEqual("invalid-path");
    });

    it("treats backslashes as separators", function () {
      const result = parse([
        entry("my-theme\\index.html", "<h1>Hi</h1>"),
        entry("my-theme\\style.css", "body{}"),
      ]);

      expect(result.views.map((v) => v.name).sort()).toEqual([
        "index.html",
        "style.css",
      ]);
    });
  });

  describe("ignored files", function () {
    it("ignores system files without failing the upload", function () {
      const result = parse([
        entry("index.html", "<h1>Hi</h1>"),
        entry(".DS_Store", "junk"),
        entry("index.html.swp", "junk"),
      ]);

      expect(result.views.map((v) => v.name)).toEqual(["index.html"]);
      expect(result.ignored.map((i) => i.path).sort()).toEqual([
        ".DS_Store",
        "index.html.swp",
      ]);
    });

    it("ignores hidden files and folders", function () {
      const result = parse([
        entry("my-theme/index.html", "<h1>Hi</h1>"),
        entry("my-theme/.git/config", "junk"),
        entry("my-theme/.env", "SECRET=1"),
      ]);

      expect(result.views.map((v) => v.name)).toEqual(["index.html"]);
      expect(result.ignored.length).toEqual(2);
    });

    it("fails when every file was ignored", function () {
      const problems = problemsFrom([entry(".DS_Store", "junk")]);

      expect(problems[0].reason).toEqual("empty");
    });
  });

  describe("package.json", function () {
    it("is optional", function () {
      const result = parse([entry("index.html", "<h1>Hi</h1>")]);

      expect(result.views.length).toEqual(1);
      expect(result.locals).toEqual({});
    });

    it("is never stored as a view", function () {
      const result = parse([
        entry("index.html", "<h1>Hi</h1>"),
        entry("package.json", JSON.stringify({ name: "Example" })),
      ]);

      expect(result.views.map((v) => v.name)).toEqual(["index.html"]);
    });

    it("rejects an upload holding two manifests", function () {
      // A zip can carry two entries of the same name. Taking whichever came
      // first would build the template from a stale manifest without saying so.
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry("package.json", JSON.stringify({ name: "Old" })),
        entry("package.json", JSON.stringify({ name: "New" })),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].reason).toEqual("duplicate");
      expect(problems[0].path).toEqual("package.json");
    });

    it("rejects a view name which only differs from package.json by case", function () {
      // writeToFolder always generates a package.json beside the views, so on
      // a case-insensitive filesystem one would overwrite the other
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry("package.json", JSON.stringify({ name: "Theme" })),
        entry("Package.json", "not the manifest"),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].reason).toEqual("duplicate");
      expect(problems[0].path).toEqual("Package.json");
    });

    it("rejects a manifest which is not valid UTF-8", function () {
      // Decoding would replace the bad byte and the JSON would still parse,
      // saving a quietly corrupted name
      const bad = Buffer.concat([
        Buffer.from('{"name":"Caf', "utf8"),
        Buffer.from([0xff]),
        Buffer.from('"}', "utf8"),
      ]);

      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry("package.json", bad),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].path).toEqual("package.json");
      expect(problems[0].reason).toEqual("binary");
    });

    it("rejects a view setting which should be an object", function () {
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry(
          "package.json",
          JSON.stringify({ views: { "index.html": { locals: "bad" } } })
        ),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].path).toEqual("index.html");
      expect(problems[0].message).toContain("locals");
    });

    it("treats a null setting as absent rather than failing on it", function () {
      // viewModel does not accept null for an object, so this has to be
      // dropped here or setView rejects it after the template exists
      const result = parse([
        entry("index.html", "<h1>Hi</h1>"),
        entry(
          "package.json",
          JSON.stringify({
            views: { "index.html": { locals: null, retrieve: null } },
          })
        ),
      ]);

      const view = viewNamed(result, "index.html");

      expect("locals" in view).toBe(false);
      expect("retrieve" in view).toBe(false);
    });

    it("rejects a view whose settings push it over the payload limit", function () {
      // The file itself is small; its locals are not. setView weighs the two
      // together, so this has to be caught before the template is created.
      const locals = {};
      for (let i = 0; i < 40000; i++) locals[`key-${i}`] = "x".repeat(50);

      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry(
          "package.json",
          JSON.stringify({ views: { "index.html": { locals } } })
        ),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].reason).toEqual("size");
      expect(problems[0].path).toEqual("index.html");
    });

    it("rejects a view setting which is a list where an object belongs", function () {
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry(
          "package.json",
          JSON.stringify({ views: { "index.html": { partials: ["a"] } } })
        ),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].message).toContain("partials");
    });

    it("reports malformed JSON with a line number", function () {
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry("package.json", '{\n  "name": "Example",\n}'),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].path).toEqual("package.json");
      expect(problems[0].reason).toEqual("manifest");
      expect(problems[0].message).toContain("line");
    });

    it("rejects a manifest which is not an object", function () {
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry("package.json", "[1, 2, 3]"),
      ]);

      expect(problems[0].reason).toEqual("manifest");
    });

    it("applies name, locals and per-view settings", function () {
      const result = parse([
        entry("index.html", "<h1>Hi</h1>"),
        entry(
          "package.json",
          JSON.stringify({
            name: "Example",
            locals: { color: "red" },
            views: { "index.html": { url: "/", locals: { size: "big" } } },
          })
        ),
      ]);

      expect(result.name).toEqual("Example");
      expect(result.locals).toEqual({ color: "red" });
      expect(viewNamed(result, "index.html").url).toEqual("/");
      expect(viewNamed(result, "index.html").locals).toEqual({ size: "big" });
    });

    it("ignores 'enabled' and warns", function () {
      const result = parse([
        entry("index.html", "<h1>Hi</h1>"),
        entry("package.json", JSON.stringify({ enabled: true })),
      ]);

      expect(result.warnings.length).toEqual(1);
      expect(result.warnings[0]).toContain("enabled");
      // Nothing in the returned template should switch the live site
      expect(result.views.length).toEqual(1);
    });

    it("ignores 'localEditing' and warns", function () {
      const result = parse([
        entry("index.html", "<h1>Hi</h1>"),
        entry("package.json", JSON.stringify({ localEditing: true })),
      ]);

      expect(result.warnings.length).toEqual(1);
      expect(result.warnings[0]).toContain("localEditing");
    });

    it("returns no presets when locals does not declare them", function () {
      const result = parse([
        entry("index.html", "<h1>Hi</h1>"),
        entry("package.json", JSON.stringify({ locals: { background_color: "#fff" } })),
      ]);

      expect(result.locals.presets).toBeUndefined();
    });

    it("passes presets through unvalidated, including an unknown font id", function () {
      const result = parse([
        entry("index.html", "<h1>Hi</h1>"),
        entry(
          "package.json",
          JSON.stringify({
            locals: {
              background_color: "#fff",
              font: { id: "verdana" },
              presets: {
                colors: { Classic: { background_color: "#ffffff" } },
                fonts: { Missing: { font: { id: "not-a-real-font" } } },
              },
            },
          })
        ),
      ]);

      expect(result.locals.presets.colors.Classic.background_color).toEqual("#ffffff");
      expect(result.locals.presets.fonts.Missing.font.id).toEqual("not-a-real-font");
    });

    it("warns about settings for files which were not uploaded", function () {
      const result = parse([
        entry("index.html", "<h1>Hi</h1>"),
        entry(
          "package.json",
          JSON.stringify({ views: { "entry.html": { url: "/entry" } } })
        ),
      ]);

      expect(result.warnings.length).toEqual(1);
      expect(result.warnings[0]).toContain("entry.html");
      // A warning, not a failure
      expect(result.views.length).toEqual(1);
    });
  });

  describe("view contents", function () {
    it("defaults a view's url to its name", function () {
      const result = parse([entry("index.html", "<h1>Hi</h1>")]);

      expect(viewNamed(result, "index.html").url).toEqual("/index.html");
    });

    it("rejects binary files", function () {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry("logo.png", png),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].reason).toEqual("binary");
      expect(problems[0].path).toEqual("logo.png");
    });

    it("rejects invalid UTF-8", function () {
      const problems = problemsFrom([
        entry("index.html", Buffer.from([0xc3, 0x28])),
      ]);

      expect(problems[0].reason).toEqual("binary");
    });

    it("accepts multi-byte UTF-8", function () {
      const result = parse([entry("index.html", "<h1>café 🎉</h1>")]);

      expect(viewNamed(result, "index.html").content).toEqual("<h1>café 🎉</h1>");
    });

    it("rejects files over the per-view limit", function () {
      const big = "x".repeat(UPLOAD_MAX_VIEW_BYTES + 1);
      const problems = problemsFrom([entry("index.html", big)]);

      expect(problems[0].reason).toEqual("size");
    });

    it("reports Mustache syntax errors with a line number", function () {
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>\n{{#entries}}\nno closing tag"),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].path).toEqual("index.html");
      expect(problems[0].reason).toEqual("template");
      expect(problems[0].message).toContain("line");
    });

    it("rejects a url which is not text", function () {
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry(
          "package.json",
          JSON.stringify({ views: { "index.html": { url: 42 } } })
        ),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].reason).toEqual("manifest");
      expect(problems[0].path).toEqual("index.html");
    });

    it("rejects a url list containing something which is not text", function () {
      // urlNormalizer requires a string, and setView maps it over this array
      // inside a callback nothing catches, so this has to be caught here
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry(
          "package.json",
          JSON.stringify({ views: { "index.html": { url: ["/", 42] } } })
        ),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].reason).toEqual("manifest");
    });

    it("rejects a urlPatterns list containing something which is not text", function () {
      const problems = problemsFrom([
        entry("index.html", "<h1>Hi</h1>"),
        entry(
          "package.json",
          JSON.stringify({
            views: { "index.html": { urlPatterns: ["/", null] } },
          })
        ),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].reason).toEqual("manifest");
    });

    it("still accepts a list of urls which are all text", function () {
      const result = parse([
        entry("feed.rss", "<rss></rss>"),
        entry(
          "package.json",
          JSON.stringify({ views: { "feed.rss": { url: ["/feed.rss", "/rss"] } } })
        ),
      ]);

      expect(viewNamed(result, "feed.rss").url).toEqual(["/feed.rss", "/rss"]);
    });

    it("rejects names which differ only by case", function () {
      const problems = problemsFrom([
        entry("Index.html", "<h1>Hi</h1>"),
        entry("index.html", "<h1>Hi</h1>"),
      ]);

      expect(problems.length).toEqual(1);
      expect(problems[0].reason).toEqual("duplicate");
    });

    it("rejects more usable files than the limit", function () {
      const entries = [];
      for (let i = 0; i < UPLOAD_MAX_FILES + 1; i++) {
        entries.push(entry(`view-${i}.html`, "hello"));
      }

      const problems = problemsFrom(entries);

      expect(problems[0].reason).toEqual("count");
    });

    it("does not count package.json towards the limit", function () {
      // A template with exactly the maximum number of views has to survive a
      // download and re-upload, and its zip carries a package.json too
      const entries = [];
      for (let i = 0; i < UPLOAD_MAX_FILES; i++) {
        entries.push(entry(`view-${i}.html`, "hello"));
      }
      entries.push(entry("package.json", JSON.stringify({ name: "Full" })));

      const result = parse(entries);

      expect(result.views.length).toEqual(UPLOAD_MAX_FILES);
      expect(result.name).toEqual("Full");
    });

    it("does not count ignored files towards the limit", function () {
      // A template kept in a git working tree carries hundreds of entries
      // under .git which never become views
      const entries = [entry("my-theme/index.html", "<h1>Hi</h1>")];

      for (let i = 0; i < UPLOAD_MAX_FILES * 2; i++) {
        entries.push(entry(`my-theme/.git/objects/${i}`, "junk"));
      }

      const result = parse(entries);

      expect(result.views.map((v) => v.name)).toEqual(["index.html"]);
      expect(result.ignored.length).toEqual(UPLOAD_MAX_FILES * 2);
    });

    it("refuses to look at an absurd number of files", function () {
      const entries = [];
      for (let i = 0; i < UPLOAD_MAX_RAW_FILES + 1; i++) {
        entries.push(entry(`.git/objects/${i}`, "junk"));
      }

      const problems = problemsFrom(entries);

      expect(problems[0].reason).toEqual("count");
    });

    it("collects every problem rather than only the first", function () {
      const problems = problemsFrom([
        entry("one.html", "{{#unclosed}}"),
        entry("two.html", "{{#alsoUnclosed}}"),
      ]);

      expect(problems.length).toEqual(2);
    });
  });

  describe("naming", function () {
    it("prefers the manifest name over the zip file name", function () {
      const result = parse(
        [
          entry("index.html", "<h1>Hi</h1>"),
          entry("package.json", JSON.stringify({ name: "Manifest" })),
        ],
        { fallbackName: "downloaded-template" }
      );

      expect(result.name).toEqual("Manifest");
    });

    it("prefers the folder name over the zip file name", function () {
      const result = parse([entry("my-theme/index.html", "<h1>Hi</h1>")], {
        fallbackName: "downloaded-template",
      });

      expect(result.name).toEqual("my-theme");
    });

    it("falls back to the zip file name", function () {
      const result = parse([entry("index.html", "<h1>Hi</h1>")], {
        fallbackName: "downloaded-template",
      });

      expect(result.name).toEqual("downloaded-template");
    });

    it("prefers the manifest name over the folder name", function () {
      const result = parse([
        entry("my-theme/index.html", "<h1>Hi</h1>"),
        entry("my-theme/package.json", JSON.stringify({ name: "Manifest" })),
      ]);

      expect(result.name).toEqual("Manifest");
    });

    it("falls back to the folder name", function () {
      const result = parse([entry("my-theme/index.html", "<h1>Hi</h1>")]);

      expect(result.name).toEqual("my-theme");
    });

    it("falls back to a fixed name for loose files", function () {
      const result = parse([entry("index.html", "<h1>Hi</h1>")]);

      expect(result.name).toEqual(UPLOAD_FALLBACK_NAME);
    });

    it("skips a name which slugs to nothing", function () {
      // The template's id, and so every url in its editor, comes from the
      // name. '!!!' leaves nothing behind, which would create a template at
      // an id of just the owner.
      const result = parse([
        entry("my-theme/index.html", "<h1>Hi</h1>"),
        entry("my-theme/package.json", JSON.stringify({ name: "!!!" })),
      ]);

      expect(result.name).toEqual("my-theme");
    });

    it("falls back to a usable name when nothing else slugs", function () {
      const result = parse(
        [
          entry("---/index.html", "<h1>Hi</h1>"),
          entry("---/package.json", JSON.stringify({ name: "!!!" })),
        ],
        { fallbackName: "???" }
      );

      expect(result.name).toEqual(UPLOAD_FALLBACK_NAME);
    });

    it("truncates long names", function () {
      const result = parse([
        entry("index.html", "<h1>Hi</h1>"),
        entry("package.json", JSON.stringify({ name: "x".repeat(200) })),
      ]);

      expect(result.name.length).toEqual(100);
    });
  });

  describe("round trip with package.generate", function () {
    // The download-zip route writes each view at the archive root plus a
    // generated package.json. Unzipping that and dropping it back in should
    // reproduce the same views — in particular the same urls.
    it("preserves view urls, locals and partials", function () {
      const views = {
        "index.html": {
          name: "index.html",
          content: "<h1>{{title}}</h1>",
          url: "/",
          locals: { size: "big" },
          partials: { head: "head.html" },
        },
        "entry.html": {
          name: "entry.html",
          content: "<article>{{title}}</article>",
          url: "/entry.html",
          locals: {},
          partials: {},
        },
        "feed.rss": {
          name: "feed.rss",
          content: "<rss></rss>",
          url: "/feed.rss",
          urlPatterns: ["/feed.rss", "/rss"],
          locals: {},
          partials: {},
        },
      };

      const metadata = { name: "Example", locals: { color: "red" } };
      const generated = Template.package.generate("blog_1", metadata, views);

      const entries = Object.keys(views).map((name) =>
        entry(name, views[name].content)
      );
      entries.push(entry("package.json", generated));

      const result = parse(entries);

      expect(result.name).toEqual("Example");
      expect(result.locals).toEqual({ color: "red" });

      expect(viewNamed(result, "index.html").url).toEqual("/");
      expect(viewNamed(result, "index.html").locals).toEqual({ size: "big" });
      expect(viewNamed(result, "index.html").partials).toEqual({
        head: "head.html",
      });

      // package.generate omits a url which equals '/' + name, so the parser
      // must default to exactly that or the url changes on every round trip
      expect(viewNamed(result, "entry.html").url).toEqual("/entry.html");

      expect(viewNamed(result, "feed.rss").url).toEqual(["/feed.rss", "/rss"]);
    });
  });
});
