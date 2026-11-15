describe("storage/sweepGenerated", function () {
  global.test.blog();

  const s3 = require("storage/s3");
  const Entries = require("models/entries");
  const sweep = require("storage/sweepGenerated");

  it("finds generated directories mentioned anywhere in a value", function () {
    const used = sweep.referencesIn(
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

  it("reports unreferenced directories, and past the grace period only old ones", async function () {
    const id = this.blog.id;
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const recent = new Date();

    spyOn(Entries, "each").and.callFake(async (blogID, fn) => {
      await fn({ html: `<img src="/_image_cache/used/a.jpg">` });
      await fn({ deleted: true, html: `<img src="/_image_cache/gone/a.jpg">` });
    });

    const objects = {
      [id + "/_image_cache/"]: [
        { key: id + "/_image_cache/used/a.jpg", size: 10, modified: old },
        { key: id + "/_image_cache/gone/a.jpg", size: 20, modified: old },
        { key: id + "/_image_cache/new/a.jpg", size: 40, modified: recent },
      ],
    };

    spyOn(s3, "listEntries").and.callFake(async function* (prefix) {
      yield* objects[prefix] || [];
    });

    const { totals, unreferenced } = await sweep.report(id, {
      graceDays: 60,
      listUnreferenced: true,
    });

    expect(totals._image_cache).toEqual({
      stored: 70,
      referenced: 10,
      unreferenced: 60,
      oldEnough: 20,
    });
    expect(unreferenced.sort()).toEqual([
      "_image_cache/gone",
      "_image_cache/new",
    ]);
  });
});
