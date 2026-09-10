describe("template", function () {
  var fs = require("fs-extra");
  var { join } = require("path");

  var makeID = require("../index").makeID;
  var setView = require("../index").setView;
  var setMetadata = require("../index").setMetadata;
  var getMetadata = require("../index").getMetadata;
  var writeToFolder = require("../index").writeToFolder;
  var establishSyncLock = require("sync/establishSyncLock");
  var repairDivergentSlug = require("../util/repairDivergentSlug");

  require("./setup")({ createTemplate: true });

  afterEach(function () {
    fs.removeSync(this.blogDirectory + "/Templates");
    fs.removeSync(this.blogDirectory + "/templates");
  });

  var call = function (fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      fn.apply(null, args.concat(function (err, value) {
        if (err) return reject(err);
        resolve(value);
      }));
    });
  };

  it("repairs a divergent locally-edited template: slug round-trips, folder moves, local-only files survive", async function () {
    var blog = this.blog;
    var templateID = this.template.id;

    // A locally edited template with a view on disk.
    await call(setView, templateID, { name: "entry.html", content: "<h1>hi</h1>" });
    await call(setMetadata, templateID, { localEditing: true });
    await call(writeToFolder, blog.id, templateID);

    var goodSlug = (await call(getMetadata, templateID)).slug;
    var root = fs.existsSync(this.blogDirectory + "/Templates")
      ? "Templates"
      : "templates";
    expect(fs.existsSync(join(this.blogDirectory, root, goodSlug))).toBe(true);

    // Force divergence: a stored slug long enough that makeID's 30-character
    // cap shortens it to something other than the id, plus the on-disk folder
    // renamed to match that stale slug.
    var staleSlug =
      "a-deliberately-divergent-slug-that-is-really-quite-long-indeed";
    expect(makeID(blog.id, staleSlug)).not.toEqual(templateID);

    fs.moveSync(
      join(this.blogDirectory, root, goodSlug),
      join(this.blogDirectory, root, staleSlug)
    );
    await call(setMetadata, templateID, { slug: staleSlug });

    // An ignored file and a nested local-only file the move must preserve.
    fs.outputFileSync(
      join(this.blogDirectory, root, staleSlug, ".DS_Store"),
      "junk"
    );
    fs.outputFileSync(
      join(this.blogDirectory, root, staleSlug, "partials/head.html"),
      "<meta>"
    );

    var divergent = await call(getMetadata, templateID);
    expect(makeID(blog.id, divergent.slug)).not.toEqual(templateID);

    // Run the repair the way the script does — under a real sync lock.
    var syncLock = await establishSyncLock(blog.id);
    var result;
    try {
      result = await repairDivergentSlug(blog, divergent, { apply: true });
    } finally {
      await syncLock.done();
    }

    expect(result.repaired).toBe(true);

    // The stored slug now round-trips to the id.
    var fixed = await call(getMetadata, templateID);
    expect(makeID(blog.id, fixed.slug)).toEqual(templateID);
    expect(fixed.slug).toEqual(templateID.split(":").slice(1).join(":"));

    // The folder moved to the new name; the stale directory is gone.
    expect(fs.existsSync(join(this.blogDirectory, root, fixed.slug))).toBe(true);
    expect(fs.existsSync(join(this.blogDirectory, root, staleSlug))).toBe(false);

    // Nested and ignored local-only files came across with it.
    expect(
      fs.readFileSync(
        join(this.blogDirectory, root, fixed.slug, "partials/head.html"),
        "utf8"
      )
    ).toEqual("<meta>");
    expect(
      fs.existsSync(join(this.blogDirectory, root, fixed.slug, ".DS_Store"))
    ).toBe(true);
  });

  it("refuses a template directory that contains a symlink and touches nothing", async function () {
    var blog = this.blog;
    var templateID = this.template.id;

    await call(setView, templateID, { name: "entry.html", content: "<h1>hi</h1>" });
    await call(setMetadata, templateID, { localEditing: true });
    await call(writeToFolder, blog.id, templateID);

    var goodSlug = (await call(getMetadata, templateID)).slug;
    var root = fs.existsSync(this.blogDirectory + "/Templates")
      ? "Templates"
      : "templates";

    var staleSlug =
      "another-deliberately-divergent-slug-that-is-really-quite-long";
    fs.moveSync(
      join(this.blogDirectory, root, goodSlug),
      join(this.blogDirectory, root, staleSlug)
    );
    await call(setMetadata, templateID, { slug: staleSlug });

    fs.symlinkSync(
      "entry.html",
      join(this.blogDirectory, root, staleSlug, "link.html")
    );

    var divergent = await call(getMetadata, templateID);
    var syncLock = await establishSyncLock(blog.id);
    var result;
    try {
      result = await repairDivergentSlug(blog, divergent, { apply: true });
    } finally {
      await syncLock.done();
    }

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("symlink");
    // The stored slug and the folder are untouched, so a rerun retries.
    expect((await call(getMetadata, templateID)).slug).toEqual(staleSlug);
    expect(fs.existsSync(join(this.blogDirectory, root, staleSlug))).toBe(true);
    expect(fs.existsSync(join(this.blogDirectory, root, divergent.id.split(":").slice(1).join(":")))).toBe(false);
  });
});
