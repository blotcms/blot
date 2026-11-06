// The pandoc worker (jobs/pandoc-worker.lua), which production runs, must
// answer exactly as the in-process job (jobs/pandoc.js), which development and
// the other specs run: every converter fixture, through both.
describe("sandbox pandoc worker", function () {
  const fs = require("fs-extra");
  const path = require("path");
  const { spawn } = require("child_process");
  const job = require("../jobs/pandoc");

  const converters = path.join(__dirname, "../../build/converters");
  const files = path.join(converters, "markdown/tests/examples/files");

  let worker;
  let buffer = Buffer.alloc(0);
  let waiting = null;

  function drain() {
    if (!waiting) return;
    const end = buffer.indexOf(10);
    if (end === -1) return;
    const head = buffer.subarray(0, end).toString();
    if (head === "E") {
      buffer = buffer.subarray(end + 1);
      return settle({ refused: true });
    }
    const length = Number(head);
    if (buffer.length - end - 1 < length) return;
    const body = buffer.subarray(end + 1, end + 1 + length);
    buffer = buffer.subarray(end + 1 + length);
    // As app/sandbox/index.js reads a jail's stdout
    const line = body.indexOf(10);
    const { meta, lengths } = JSON.parse(body.subarray(0, line).toString());
    let offset = line + 1;
    const outputs = lengths.map((n) => body.subarray(offset, (offset += n)));
    expect(offset).toEqual(body.length);
    settle({ meta, outputs });
  }

  function settle(result) {
    const resolve = waiting;
    waiting = null;
    resolve(result);
  }

  // Sends one request, in frames of at most 4 KiB as the broker might
  function ask(args, input) {
    return new Promise((resolve) => {
      waiting = resolve;
      const request = Buffer.concat([
        Buffer.from(JSON.stringify(args) + "\n"),
        input,
      ]);
      for (let i = 0; i < request.length; i += 4096) {
        const chunk = request.subarray(i, i + 4096);
        worker.stdin.write(chunk.length + "\n");
        worker.stdin.write(chunk);
      }
      worker.stdin.write("0\n");
      drain();
    });
  }

  beforeAll(function () {
    worker = spawn(
      job.pandocPath(),
      [
        "+RTS",
        "-M400M",
        "-RTS",
        "lua",
        path.join(__dirname, "../jobs/pandoc-worker.lua"),
      ],
      {
        env: {},
      }
    );
    worker.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      drain();
    });
  });

  afterAll(function () {
    worker.stdin.end();
  });

  // The HTML with the media directory replaced, and the media by name
  function comparable({ meta, outputs }) {
    if (meta.error) return { error: true };
    return {
      html: outputs[0].toString().split(meta.dir).join("<dir>"),
      media: meta.media
        .map((name, i) => [name, outputs[i + 1].toString("base64")])
        .sort(),
    };
  }

  async function same(args, input) {
    const expected = comparable(await job.run(args, input));
    const actual = comparable(await ask(args, input));
    expect(actual).toEqual(expected);
  }

  for (const format of ["docx", "odt", "rtf", "org"]) {
    it(
      "converts every " + format + " fixture as the job does",
      async function () {
        const tests = path.join(converters, format, "tests");
        const directory = (await fs.pathExists(path.join(tests, "examples")))
          ? path.join(tests, "examples")
          : tests;
        const fixtures = (await fs.readdir(directory)).filter((name) =>
          name.endsWith("." + format)
        );
        expect(fixtures.length).toBeGreaterThan(0);
        for (const name of fixtures)
          await same(
            { from: format },
            await fs.readFile(path.join(directory, name))
          );
      },
      60000
    );
  }

  it("converts every markdown fixture as the job does, with and without katex and callouts", async function () {
    const directory = path.join(converters, "markdown/tests/examples");
    const fixtures = (await fs.readdir(directory)).filter((name) =>
      name.endsWith(".txt")
    );
    const extra = [
      "> [!tip] A title\n> The body\n\n> [!warning]- Folded\n> text\n",
      "Inline $x^2$ and display\n\n$$\ny = mx + c\n$$\n",
      "Some code:\n\n```js\nconst x = 1;\n```\n\nsee p. 30 and chap. 3, mail me@example.com\n",
    ];
    const inputs = (
      await Promise.all(
        fixtures.map((name) => fs.readFile(path.join(directory, name)))
      )
    ).concat(extra.map((text) => Buffer.from(text)));
    for (const input of inputs) {
      for (const katex of [false, true]) {
        for (const callouts of [false, true])
          await same({ from: "markdown", katex, callouts }, input);
      }
    }
  }, 120000);

  it("reads the bibliography and CSL after the document, as the job does", async function () {
    const bib = await fs.readFile(path.join(files, "bibliography.bib"));
    const csl = await fs.readFile(path.join(files, "style.csl"));
    for (const [bibliography, style] of [
      [bib, csl],
      [bib, null],
    ]) {
      const args = {
        from: "markdown",
        katex: false,
        callouts: false,
        bibliography: { length: bibliography.length, extension: ".bib" },
        csl: style ? { length: style.length, extension: ".csl" } : null,
      };
      const input = Buffer.concat(
        [Buffer.from("@item1 says [see @item2, p. 3]\n")].concat(
          style ? [bibliography, style] : [bibliography]
        )
      );
      await same(args, input);
      const { outputs } = await ask(args, input);
      expect(outputs[0].toString().toLowerCase()).toContain("first book");
    }
  });

  it("has the abbreviations of the pandoc it runs with", async function () {
    const { execFileSync } = require("child_process");
    const expected = execFileSync(job.pandocPath(), [
      "--print-default-data-file",
      "abbreviations",
    ]).toString();
    expect(
      await fs.readFile(
        path.join(__dirname, "../jobs/pandoc-abbreviations"),
        "utf8"
      )
    ).toEqual(expected);
  });

  it("answers a document pandoc can't convert with meta.error, and carries on", async function () {
    const { meta, outputs } = await ask(
      { from: "docx" },
      Buffer.from("not a docx")
    );
    expect(meta.error.code).not.toEqual(0);
    expect(meta.error.stderr).toContain("docx");
    expect(outputs).toEqual([]);

    const after = await ask(
      { from: "markdown", katex: false, callouts: false },
      Buffer.from("Hello *world*")
    );
    expect(after.outputs[0].toString()).toEqual(
      "<p>Hello <em>world</em></p>\n"
    );
  });

  it("refuses the arguments the job refuses, and carries on", async function () {
    const bad = [
      null,
      {},
      { from: "html" },
      { from: "markdown" },
      { from: "markdown", katex: "yes", callouts: false },
      {
        from: "markdown",
        katex: false,
        callouts: false,
        bibliography: { length: 1, extension: "/../x" },
      },
      {
        from: "markdown",
        katex: false,
        callouts: false,
        csl: { length: -1, extension: ".csl" },
      },
      {
        from: "markdown",
        katex: false,
        callouts: false,
        bibliography: { length: 100, extension: ".bib" },
      },
    ];
    for (const args of bad)
      expect(await ask(args, Buffer.from("x"))).toEqual({ refused: true });

    const after = await ask({ from: "rtf" }, Buffer.from("{\\rtf1 hi}"));
    expect(after.outputs[0].toString()).toContain("hi");
  });
});
