describe("sandbox pandoc job", function () {
  const fs = require("fs-extra");
  const path = require("path");
  const config = require("config");
  const sandbox = require("../");
  const pandoc = require("build/converters/pandoc");

  const converters = path.join(__dirname, "../../build/converters");
  const files = path.join(converters, "markdown/tests/examples/files");

  let socket;

  beforeEach(function () {
    // no broker: the job runs in-process
    socket = config.sandbox.socket;
    config.sandbox.socket = "";
  });

  afterEach(function () {
    config.sandbox.socket = socket;
  });

  const markdown = { from: "markdown", katex: false, callouts: false };

  async function rejection(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error("did not reject");
  }

  it("converts markdown to HTML, with no media", async function () {
    const { meta, outputs } = await sandbox.run("pandoc", markdown, Buffer.from("Hello *world*"));

    expect(meta.media).toEqual([]);
    expect(outputs.length).toEqual(1);
    expect(outputs[0].toString()).toEqual("<p>Hello <em>world</em></p>\n");
  });

  it("returns a docx's media as outputs, named under the directory its HTML points at", async function () {
    const input = await fs.readFile(path.join(converters, "docx/tests/image.docx"));
    const { meta, outputs } = await sandbox.run("pandoc", { from: "docx" }, input);

    expect(meta.media.sort()).toEqual(["media/rId20.png", "media/rId23.png"]);
    expect(outputs.length).toEqual(3);
    expect(outputs[0].toString()).toContain('src="' + meta.dir + "/media/rId20.png");
    expect(outputs[1].subarray(1, 4).toString()).toEqual("PNG");
  });

  it("reads the bibliography and CSL after the document", async function () {
    const document = Buffer.from("@item1\n");
    const bib = await fs.readFile(path.join(files, "bibliography.bib"));
    const csl = await fs.readFile(path.join(files, "style.csl"));
    const args = Object.assign({}, markdown, {
      bibliography: { length: bib.length, extension: ".bib" },
      csl: { length: csl.length, extension: ".csl" },
    });

    const { outputs } = await sandbox.run("pandoc", args, Buffer.concat([document, bib, csl]));

    expect(outputs[0].toString()).toContain("First book");
  });

  it("returns a document pandoc can't convert as meta.error", async function () {
    const { meta, outputs } = await sandbox.run("pandoc", { from: "docx" }, Buffer.from("not a docx"));

    expect(meta.error.code).not.toEqual(0);
    expect(meta.error.stderr).toContain("docx");
    expect(outputs).toEqual([]);
  });

  it("checks its arguments", async function () {
    const bad = [
      null,
      {},
      { from: "html" },
      { from: "markdown" },
      { from: "markdown", katex: "yes", callouts: false },
      Object.assign({}, markdown, { bibliography: { length: 1, extension: "/../x" } }),
      Object.assign({}, markdown, { csl: { length: -1, extension: ".csl" } }),
      Object.assign({}, markdown, { bibliography: { length: 100, extension: ".bib" } }),
    ];

    for (const args of bad) {
      expect(await rejection(sandbox.run("pandoc", args, Buffer.from("x")))).toEqual(jasmine.any(Error));
    }
  });

  it("ignores options other than its own", async function () {
    const args = { from: "rtf", katex: true, args: ["--lua-filter", "/x.lua"] };
    const { outputs } = await sandbox.run("pandoc", args, Buffer.from("{\\rtf1 hi}"));

    expect(outputs[0].toString()).toContain("hi");
  });

  describe("caller", function () {
    it("rejects with pandoc's error", async function () {
      const err = await rejection(pandoc({ from: "docx" }, Buffer.from("not a docx")));
      expect(err.message).toMatch(/^Pandoc exited with code \d+/);
    });

    it("sends the bibliography and CSL files after the document", async function () {
      const { html } = await pandoc(markdown, Buffer.from("@item1\n"), {
        bibliography: path.join(files, "bibliography.bib"),
        csl: path.join(files, "style.csl"),
      });

      expect(html).toContain("First book");
    });

    it("reports pandoc killed by something other than its timeout", async function () {
      const alerts = require("sandbox/alerts");
      spyOn(alerts, "jobFailed");
      const run = spyOn(sandbox, "run");
      const error = { code: null, signal: "SIGKILL", ms: 5, stderr: "" };

      run.and.returnValue(Promise.resolve({ meta: { error: Object.assign({ timedOut: false }, error) }, outputs: [] }));
      const killed = await rejection(pandoc({ from: "docx" }, Buffer.from("")));
      expect(killed.code).toEqual("SANDBOX_KILLED");
      expect(alerts.jobFailed).toHaveBeenCalledWith("pandoc", killed);

      run.and.returnValue(Promise.resolve({ meta: { error: Object.assign({}, error, { timedOut: true }) }, outputs: [] }));
      const timedOut = await rejection(pandoc({ from: "docx" }, Buffer.from("")));
      expect(timedOut.code).toBeUndefined();
      expect(alerts.jobFailed.calls.count()).toEqual(1);
    });

    it("rejects with pandoc's error when the broker kills a worker for taking too long", async function () {
      spyOn(sandbox, "run").and.callFake(function () {
        const err = new Error("sandbox: timeout");
        err.code = "SANDBOX_TIMEOUT";
        return Promise.reject(err);
      });
      const err = await rejection(pandoc({ from: "docx" }, Buffer.from("")));
      expect(err.message).toMatch(/^Pandoc exited with code null \(SIGKILL\) \(timed out\)/);
      expect(err.code).toBeUndefined();
    });

    it("refuses media names that leave the directory", async function () {
      const run = spyOn(sandbox, "run");
      for (const name of ["../x.png", "/x.png", "a//b.png", "a/./b.png", ""]) {
        run.and.returnValue(
          Promise.resolve({ meta: { dir: "/tmp/x", media: [name] }, outputs: [Buffer.from(""), Buffer.from("")] })
        );
        const err = await rejection(pandoc({ from: "docx" }, Buffer.from("")));
        expect(err.message).toEqual("pandoc: invalid reply");
      }
    });
  });
});
