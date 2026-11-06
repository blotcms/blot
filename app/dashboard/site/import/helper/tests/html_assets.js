describe("import stages' use of the parse-html job", function () {
  const cheerio = require("cheerio");
  const fs = require("fs-extra");
  const sandbox = require("sandbox");
  const sandboxFetch = require("sandbox/fetch");
  const downloadImages = require("../download_images");
  const downloadPdfs = require("../download_pdfs");
  const downloadAudio = require("../download_audio");
  const convertToMarkdown = require("../convert_to_markdown");

  const run = (stage, post) =>
    new Promise((resolve, reject) =>
      stage(post, (err, result) => (err ? reject(err) : resolve(result)))
    );
  const jobs = () =>
    sandbox.run.calls
      .allArgs()
      .filter((args) => args[0] === "parse-html")
      .map((args) => args[1].op);

  let post;

  beforeEach(function () {
    post = { metadata: {} };
    spyOn(console, "log");
    spyOn(sandbox, "run").and.callThrough();
  });

  afterEach(async function () {
    if (post.asset_directory) await fs.remove(post.asset_directory);
  });

  const served = (kind, data) => async (requests) =>
    requests.map((request) => ({
      ok: true,
      status: 200,
      kind,
      data,
      format: "png",
      headers: {},
    }));

  it("scan once, and keep the parser's HTML, when there is nothing to download", async function () {
    const html =
      "<p>Nothing <b>to fetch</p><img src='data:image/png;base64,AA'><a href='/page'>x</a>";
    spyOn(sandboxFetch, "batch");
    spyOn(sandboxFetch, "many");

    for (const stage of [downloadImages, downloadPdfs, downloadAudio]) {
      sandbox.run.calls.reset();
      post.html = html;
      const result = await run(stage, post);

      expect(jobs()).toEqual(["scan"]);
      expect(result.html).toBe(
        cheerio.load(html, { decodeEntities: false }).html()
      );
    }
    expect(sandboxFetch.batch).not.toHaveBeenCalled();
    expect(sandboxFetch.many).not.toHaveBeenCalled();
  });

  it("scan and then rewrite once when something was downloaded, however many images", async function () {
    post.html =
      '<img src="https://example.com/a.png"><img src="https://example.com/b.png"><img src="https://example.com/a.png">';
    spyOn(sandboxFetch, "batch").and.callFake(
      served("image", Buffer.from("png"))
    );
    spyOn(sandboxFetch, "many").and.callFake(
      served("image", Buffer.from("png"))
    );

    const result = await run(downloadImages, post);

    expect(jobs()).toEqual(["scan", "rewrite"]);
    expect(result.html).toBe(
      cheerio
        .load('<img src="_a.png"><img src="_b.png"><img src="_a.png">', {
          decodeEntities: false,
        })
        .html()
    );
  });

  it("send the post's HTML to the jail, not the parser's, to be rewritten", async function () {
    post.html = '<p>x<img src="https://example.com/a.png"></p>';
    spyOn(sandboxFetch, "many").and.callFake(
      served("image", Buffer.from("png"))
    );

    await run(downloadImages, post);

    const rewrite = sandbox.run.calls
      .allArgs()
      .find((args) => args[1].op === "rewrite");
    expect(rewrite[1]).toEqual({
      op: "rewrite",
      kind: "images",
      replacements: [["https://example.com/a.png", "_a.png"]],
    });
    expect(rewrite[2].toString()).toBe(
      '<p>x<img src="https://example.com/a.png"></p>'
    );
  });

  it("fail the post, and download nothing, when the jail refuses the markup", async function () {
    post.html = "<div>".repeat(29000);
    spyOn(sandboxFetch, "batch");
    spyOn(sandboxFetch, "many");

    for (const stage of [
      downloadImages,
      downloadPdfs,
      downloadAudio,
      convertToMarkdown,
    ]) {
      await expectAsync(run(stage, post)).toBeRejectedWith(
        jasmine.objectContaining({
          message:
            "Could not read the post's HTML: markup is nested too deeply",
        })
      );
    }
    expect(sandboxFetch.batch).not.toHaveBeenCalled();
    expect(sandboxFetch.many).not.toHaveBeenCalled();
  });

  it("fail the post with the sandbox's error when the sandbox fails", async function () {
    post.html = "<p>x</p>";
    const failure = Object.assign(new Error("sandbox: busy"), {
      code: "SANDBOX_BUSY",
    });
    sandbox.run.and.returnValue(Promise.reject(failure));

    for (const stage of [
      downloadImages,
      downloadPdfs,
      downloadAudio,
      convertToMarkdown,
    ]) {
      await expectAsync(run(stage, post)).toBeRejectedWith(failure);
    }
  });

  it("fail the post, and not the process, with a post that has no HTML", async function () {
    post.html = undefined;
    await expectAsync(run(downloadImages, post)).toBeRejectedWith(
      jasmine.objectContaining({ message: "The post has no HTML" })
    );
  });

  it("convert to Markdown in the jail, once, and only when there is HTML and no content", async function () {
    post.html = "<p>Hello <strong>world</strong></p>";
    const result = await run(convertToMarkdown, post);
    expect(result.content).toBe("Hello **world**");
    expect(jobs()).toEqual(["markdown"]);

    sandbox.run.calls.reset();
    post = { html: "<p>x</p>", content: "kept" };
    expect((await run(convertToMarkdown, post)).content).toBe("kept");
    post = { html: "" };
    expect((await run(convertToMarkdown, post)).content).toBeUndefined();
    expect(jobs()).toEqual([]);
  });
});
