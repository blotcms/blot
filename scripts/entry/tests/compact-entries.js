describe("scripts/entry/compact-entries", function () {
  var client = require("models/client");
  var codec = require("models/entry/codec");
  var entryKey = require("models/entry/key").entry;
  var compactEntries = require("../compact-entries");

  global.test.blog();

  beforeEach(function () {
    spyOn(console, "log");
  });

  var title = "<h1>A title</h1>";
  var rest = "<p>" + "Some words in a post. ".repeat(30) + "</p>";

  // An entry as stored before the compact form, every field written out
  function whole(path, fields) {
    return JSON.stringify(
      Object.assign(
        {
          id: path,
          path: path,
          html: title + rest,
          body: rest,
          teaser: title + rest,
          teaserBody: rest,
          deleted: false,
        },
        fields
      )
    );
  }

  async function store(blogID, path, value, ttl) {
    await client.set(entryKey(blogID, path), value);
    if (ttl) await client.expire(entryKey(blogID, path), ttl);
  }

  function read(blogID, path) {
    return client.get(entryKey(blogID, path));
  }

  it("compacts entries, keeps a deleted entry's TTL, and --expand gives back the same bytes", async function () {
    var blogID = this.blog.id;
    var live = whole("/live.txt");
    var deleted = whole("/deleted.txt", { deleted: true });

    await store(blogID, "/live.txt", live);
    await store(blogID, "/deleted.txt", deleted, 1000);

    var dryRun = await compactEntries({ identifier: blogID });

    expect(dryRun.rewritten).toEqual(2);
    expect(dryRun.written).toEqual(0);
    expect(await read(blogID, "/live.txt")).toEqual(live);

    var applied = await compactEntries({ identifier: blogID, apply: true });

    expect(applied.written).toEqual(2);
    expect(applied.bytesAfter).toBeLessThan(applied.bytesBefore / 1.5);
    expect(typeof JSON.parse(await read(blogID, "/live.txt")).body).toEqual(
      "number"
    );
    expect(codec.decode(await read(blogID, "/live.txt"))).toEqual(
      JSON.parse(live)
    );
    expect(await client.ttl(entryKey(blogID, "/deleted.txt"))).toBeGreaterThan(
      0
    );

    var again = await compactEntries({ identifier: blogID, apply: true });

    expect(again.rewritten).toEqual(0);

    var expanded = await compactEntries({
      identifier: blogID,
      apply: true,
      expand: true,
    });

    expect(expanded.written).toEqual(2);
    expect(await read(blogID, "/live.txt")).toEqual(live);
    expect(await read(blogID, "/deleted.txt")).toEqual(deleted);
    expect(await client.ttl(entryKey(blogID, "/deleted.txt"))).toBeGreaterThan(
      0
    );
  });

  it("leaves an entry alone if it was saved between the read and the write", async function () {
    var blogID = this.blog.id;
    var saved = whole("/a.txt", { html: "<p>Saved by a build meanwhile</p>" });

    await store(blogID, "/a.txt", whole("/a.txt"));

    var evalCommand = client.eval.bind(client);
    spyOn(client, "eval").and.callFake(async function () {
      await store(blogID, "/a.txt", saved);
      return evalCommand.apply(null, arguments);
    });

    var totals = await compactEntries({ identifier: blogID, apply: true });

    expect(totals.written).toEqual(0);
    expect(totals.changed).toEqual(1);
    expect(await read(blogID, "/a.txt")).toEqual(saved);
  });
});
