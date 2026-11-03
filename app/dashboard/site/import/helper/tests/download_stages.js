describe("import download stages", function () {
  const fs = require("fs-extra");
  const sandboxFetch = require("sandbox/fetch");
  const downloadImages = require("../download_images");
  const downloadAudio = require("../download_audio");
  const downloadPdfs = require("../download_pdfs");

  const run = (stage, post) =>
    new Promise((resolve, reject) => stage(post, (err, result) => (err ? reject(err) : resolve(result))));

  const image = (format) => (request) => ({
    ok: true,
    status: 200,
    kind: "image",
    data: Buffer.from("re-encoded " + request.url),
    format,
    headers: { contentType: "image/" + format },
  });
  const refused = () => ({ ok: false, error: new Error("404") });

  let post;

  beforeEach(function () {
    post = { metadata: {} };
  });

  afterEach(async function () {
    if (post.asset_directory) await fs.remove(post.asset_directory);
  });

  it("fetches a post's images and thumbnail in one jail, and saves the ones that came", async function () {
    post.metadata.thumbnail = "https://example.com/thumb.jpg";
    post.html =
      '<p><img src="https://example.com/a.png"><img src="https://example.com/gone.png"><img src="data:image/png;base64,AAAA"><img src="https://example.com/a.png"></p>';
    spyOn(sandboxFetch, "many").and.callFake(async (requests) =>
      requests.map((request) =>
        request.url.includes("gone")
          ? refused()
          : image(request.url.endsWith("jpg") ? "jpeg" : "png")(request)
      )
    );

    const result = await run(downloadImages, post);

    expect(sandboxFetch.many).toHaveBeenCalledTimes(1);
    const sent = sandboxFetch.many.calls.argsFor(0)[0];
    expect(sent.map((r) => r.url)).toEqual([
      "https://example.com/thumb.jpg",
      "https://example.com/a.png",
      "https://example.com/gone.png",
    ]);
    expect(sent.every((r) => r.kind === "image")).toBe(true);
    expect(result.metadata.thumbnail).toBe("_thumb.jpg");
    expect(result.html).toContain('src="_a.png"');
    expect(result.html).toContain('src="https://example.com/gone.png"');
    expect(result.html).toContain('src="data:image/png;base64,AAAA"');
    expect(await fs.readFile(result.asset_directory + "/_a.png", "utf8")).toBe(
      "re-encoded https://example.com/a.png"
    );
  });

  it("fetches a lone image by itself, with no batch", async function () {
    post.html = '<img src="https://example.com/one.png">';
    spyOn(sandboxFetch, "many").and.callFake(async (requests) => requests.map(image("png")));

    await run(downloadImages, post);

    expect(sandboxFetch.many).toHaveBeenCalledTimes(1);
    expect(sandboxFetch.many.calls.argsFor(0)[0].length).toBe(1);
  });

  it("fetches a post's audio in one jail and keeps links it could not fetch", async function () {
    post.html =
      '<audio src="https://example.com/a.mp3"></audio><audio src="https://example.com/b.mp3"></audio><audio src="data:audio/mp3;base64,AA"></audio>';
    spyOn(sandboxFetch, "many").and.callFake(async (requests) =>
      requests.map((request) =>
        request.url.endsWith("b.mp3")
          ? refused()
          : { ok: true, status: 200, kind: "file", data: Buffer.from("song"), headers: {} }
      )
    );
    spyOn(console, "log");

    const result = await run(downloadAudio, post);

    expect(sandboxFetch.many).toHaveBeenCalledTimes(1);
    expect(sandboxFetch.many.calls.argsFor(0)[0]).toEqual([
      jasmine.objectContaining({ url: "https://example.com/a.mp3", kind: "file", check: "audio" }),
      jasmine.objectContaining({ url: "https://example.com/b.mp3", kind: "file", check: "audio" }),
    ]);
    expect(result.html).toContain('src="_a.mp3"');
    expect(result.html).toContain('src="https://example.com/b.mp3"');
  });

  it("fetches a post's PDF links in one jail, and only the .pdf ones", async function () {
    post.html =
      '<a href="https://example.com/a.pdf">a</a><a href="https://example.com/page.html">page</a><a href="https://example.com/b.pdf">b</a>';
    spyOn(sandboxFetch, "many").and.callFake(async (requests) =>
      requests.map(() => ({ ok: true, status: 200, kind: "file", data: Buffer.from("%PDF-1"), headers: {} }))
    );
    spyOn(console, "log");

    const result = await run(downloadPdfs, post);

    expect(sandboxFetch.many).toHaveBeenCalledTimes(1);
    expect(sandboxFetch.many.calls.argsFor(0)[0].map((r) => [r.url, r.check])).toEqual([
      ["https://example.com/a.pdf", "pdf"],
      ["https://example.com/b.pdf", "pdf"],
    ]);
    expect(result.html).toContain('href="_a.pdf"');
    expect(result.html).toContain('href="_b.pdf"');
    expect(result.html).toContain('href="https://example.com/page.html"');
  });
});
