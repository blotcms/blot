describe("storage/sweep/references and s3", function () {
  global.test.blog();

  const Entries = require("models/entries");
  const Entry = require("models/entry");
  const assets = require("storage/assets");
  const references = require("storage/sweep/references");
  const bucket = require("storage/sweep/s3");

  it("finds generated directories mentioned anywhere in a value", function () {
    const used = references.referencesIn(
      {
        html: '<img src="%%BLOT_CDN%%/blog_1/_image_cache/abc-123/photo.jpg">',
        thumbnail: {
          small: { url: "https://cdn.blot.im/blog_1/_thumbnails/t1/small.jpg" },
        },
        other: "/_avatars/me.png /folder/v-1/a.jpg",
      },
      new Set()
    );

    expect(Array.from(used).sort()).toEqual([
      "_image_cache/abc-123",
      "_thumbnails/t1",
    ]);
  });

  it("finds the directories a deleted entry no longer uses", async function () {
    spyOn(Entries, "getAllIDs").and.callFake(async () => [
      "/used.txt",
      "/gone.txt",
    ]);
    spyOn(Entry, "get").and.callFake(async () => [
      { html: `<img src="/_image_cache/used/a.jpg">` },
      { deleted: true, html: `<img src="/_image_cache/gone/a.jpg">` },
    ]);

    const used = await references.inUse(this.blog.id);

    expect(used.has("_image_cache/used")).toBe(true);
    expect(used.has("_image_cache/gone")).toBe(false);
  });

  it("fails a blog's references when a read fails, rather than undercounting", async function () {
    spyOn(Entries, "getAllIDs").and.callFake(async () => ["/a.txt"]);
    spyOn(Entry, "get").and.callFake(async () => {
      throw new Error("Redis went away");
    });

    const err = await references.inUse(this.blog.id).catch((err) => err);

    expect(err instanceof Error).toBe(true);
    expect(err.message).toBe("Redis went away");
  });

  it("lists a blog's generated directories with exact keys, once", async function () {
    const id = this.blog.id;
    const modified = new Date(1000);

    spyOn(assets, "walkEntries").and.callFake(() =>
      (async function* () {
        yield { relPath: "_thumbnails/a/small.jpg", modified, size: 10 };
        yield { relPath: "_thumbnails/a/large.jpg", modified, size: 20 };
        yield { relPath: "_bookmark_screenshots/abc.png", modified, size: 5 };
        yield { relPath: "_assets/doc/x.png", modified, size: 7 };
      })()
    );

    const { files, dirs } = await bucket.listing(id);

    expect(files.size).toBe(4);
    expect(Array.from(dirs.keys())).toEqual([
      "_thumbnails/a",
      "_bookmark_screenshots/abc.png",
    ]);
    expect(dirs.get("_thumbnails/a")).toEqual({
      files: 2,
      bytes: 30,
      newest: 1000,
      keys: [id + "/_thumbnails/a/small.jpg", id + "/_thumbnails/a/large.jpg"],
    });
  });
});
