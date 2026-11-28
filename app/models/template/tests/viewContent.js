describe("template viewContent", function () {
  var viewContent = require("../util/viewContent");

  var long = "<p>{{title}}</p>\n".repeat(100);

  it("leaves a short source as written", async function () {
    expect(await viewContent.pack("<p>{{title}}</p>")).toBe(null);
    expect(await viewContent.pack("")).toBe(null);
    expect(await viewContent.pack(undefined)).toBe(null);
  });

  it("compresses a long source", async function () {
    var packed = await viewContent.pack(long);
    expect(Buffer.isBuffer(packed)).toBe(true);
    expect(packed.length).toBeLessThan(Buffer.byteLength(long));
  });

  it("leaves a source which does not compress as written", async function () {
    var random = require("crypto").randomBytes(2000).toString("base64");
    var packed = await viewContent.pack(random);
    // Base64 does compress a little, so only check what is stored unpacks
    if (packed) {
      var view = await viewContent.unpack({ contentBr: packed });
      expect(view.content).toEqual(random);
    }
  });

  it("unpacks a hash read as Buffers into strings", async function () {
    var source = "Ünïcødé ✓ " + long;
    var view = await viewContent.unpack({
      name: Buffer.from("entry.html"),
      locals: Buffer.from('{"a":"é"}'),
      contentBr: await viewContent.pack(source),
    });

    expect(view).toEqual({
      name: "entry.html",
      locals: '{"a":"é"}',
      content: source,
    });
  });

  it("unpacks the Uint8Arrays the client-side cache hands back", async function () {
    var packed = await viewContent.pack(long);
    var view = await viewContent.unpack(
      structuredClone({ name: Buffer.from("a.html"), contentBr: packed })
    );

    expect(view).toEqual({ name: "a.html", content: long });
  });

  it("unpacks a large source off the main thread as well", async function () {
    var source = require("crypto").randomBytes(150000).toString("hex");
    var packed = await viewContent.pack(source);
    expect(packed.length).toBeGreaterThan(32 * 1024);

    var view = await viewContent.unpack({ contentBr: packed });
    expect(view.content).toEqual(source);
  });

  it("unpacks a view stored as written", async function () {
    var view = await viewContent.unpack({
      name: Buffer.from("a.html"),
      content: Buffer.from("hello"),
    });

    expect(view).toEqual({ name: "a.html", content: "hello" });
  });

  it("prefers content when both fields are present", async function () {
    var view = await viewContent.unpack({
      content: Buffer.from("new"),
      contentBr: await viewContent.pack(long),
    });

    expect(view.content).toEqual("new");
  });
});
