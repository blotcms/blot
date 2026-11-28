describe("entry codec", function () {
  require("./setup")();

  var codec = require("../codec");
  var get = require("../get");
  var key = require("../key");
  var redis = require("models/client");

  var title = "<h1>Ünïcödé 🙂 title</h1>";
  var rest = "<p>" + "Some words – 日本語. ".repeat(20) + "</p>";
  var more = "<p>" + "After the break. ".repeat(20) + "</p>";

  it("stores body, teaser and teaserBody as positions when they repeat html", function () {
    var entry = {
      id: "/a.txt",
      html: title + rest + more,
      body: rest + more,
      teaser: title + rest,
      teaserBody: rest,
    };

    var json = codec.encode(entry);
    var compact = JSON.parse(json);

    expect(compact.body).toEqual(title.length);
    expect(compact.teaser).toEqual((title + rest).length);
    expect(compact.teaserBody).toEqual(title.length);
    expect(json.length).toBeLessThan(JSON.stringify(entry).length / 2);
    expect(codec.decode(json)).toEqual(entry);
  });

  it("stores a body which is all of html as a position too", function () {
    var entry = {
      id: "/a.txt",
      html: rest,
      body: rest,
      teaser: rest,
      teaserBody: rest,
    };

    expect(JSON.parse(codec.encode(entry))).toEqual({
      id: "/a.txt",
      html: rest,
      body: 0,
      teaser: rest.length,
      teaserBody: 0,
    });
    expect(codec.decode(codec.encode(entry))).toEqual(entry);
  });

  it("writes out fields which don't repeat html, and short ones", function () {
    var entry = {
      id: "/a.txt",
      html: rest,
      body: "<p>Something else entirely, longer than sixteen</p>",
      teaser: "<p>Elsewhere, also long enough</p>",
      teaserBody: "",
      summary: "Hi",
    };

    expect(codec.encode(entry)).toEqual(JSON.stringify(entry));
    expect(codec.decode(codec.encode(entry))).toEqual(entry);
  });

  it("reads entries stored with every field written out, beside compact ones", async function () {
    var compact = await this.set("/a.txt", "Compact " + "words ".repeat(20));
    var whole = await this.set("/b.txt", "Whole " + "words ".repeat(20));

    // Store /a.txt compact, as Entry.set will, and /b.txt as entries are
    // stored now
    await redis.set(key.entry(this.blog.id, "/a.txt"), codec.encode(compact));
    await redis.set(key.entry(this.blog.id, "/b.txt"), JSON.stringify(whole));

    var entries = await get(this.blog.id, ["/a.txt", "/b.txt"]);

    expect(entries.map((entry) => entry.path)).toEqual(["/a.txt", "/b.txt"]);
    expect(entries[1]).toEqual(whole);
    expect(entries[0]).toEqual(compact);
    expect(typeof JSON.parse(codec.encode(compact)).body).toEqual("number");
  });
});
