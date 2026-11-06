// Converts a document to HTML with pandoc, in the jail or in-process (see
// ../index.js). The options are a fixed set per input format, chosen here from
// checked args, never flags from the caller:
//
//   { from: "markdown", katex: false, callouts: false,
//     bibliography: { length: 1234, extension: ".bib" }, csl: null }
//
// The input is the document, then the bibliography's bytes and the CSL's, whose
// lengths are in the args (markdown only). outputs[0] is the HTML and the rest
// are the media pandoc extracted from a docx or odt, named in meta.media
// relative to meta.dir, the directory the HTML's image paths start with.
// A document pandoc can't convert, a timeout, or pandoc killed by anything else
// (the jail's memory limit) is meta.error, not a failure: the caller tells the
// last apart, since the broker would only call it "failed".

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const FORMATS = ["markdown", "docx", "odt", "rtf", "org"];
const EXTENSION = /^\.[A-Za-z0-9]{1,16}$/;

// pandoc's own heap and time limits. The heap sits below the jail's 512 MiB
// (proxy/unit/sandbox/jail.js), which Node, the document and its media share,
// so a document too large for it is usually a pandoc error, not a killed jail.
const MAX_HEAP = "400M";
const TIMEOUT_MS = 10 * 1000;

// Matches maxOutputBytes in proxy/unit/sandbox/jail.js
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;
const MAX_MEDIA = 1000;

function pandocPath() {
  if (process.env.BLOT_PANDOC_PATH) return process.env.BLOT_PANDOC_PATH;
  if (fs.existsSync("/usr/local/bin/pandoc")) return "/usr/local/bin/pandoc";
  return "pandoc";
}

function checkFile(file) {
  if (file === null || file === undefined) return null;
  if (!file || typeof file !== "object") throw new Error("invalid file");
  if (!Number.isSafeInteger(file.length) || file.length < 0)
    throw new Error("invalid file length");
  if (typeof file.extension !== "string" || !EXTENSION.test(file.extension)) {
    throw new Error("invalid file extension");
  }
  return { length: file.length, extension: file.extension };
}

function check(args) {
  if (!args || typeof args !== "object") throw new Error("invalid arguments");
  if (!FORMATS.includes(args.from)) throw new Error("invalid format");

  const checked = {
    from: args.from,
    katex: false,
    callouts: false,
    bibliography: null,
    csl: null,
  };
  if (args.from !== "markdown") return checked;

  for (const flag of ["katex", "callouts"]) {
    if (typeof args[flag] !== "boolean") throw new Error("invalid " + flag);
    checked[flag] = args[flag];
  }
  checked.bibliography = checkFile(args.bibliography);
  checked.csl = checkFile(args.csl);
  return checked;
}

// Splits the input into the document and the files after it
function split(input, { bibliography, csl }) {
  const extra =
    (bibliography ? bibliography.length : 0) + (csl ? csl.length : 0);
  if (extra > input.length) throw new Error("invalid file lengths");
  let offset = input.length - extra;
  const document = input.subarray(0, offset);
  const files = {};
  for (const [name, file] of Object.entries({ bibliography, csl })) {
    if (!file) continue;
    files[name] = input.subarray(offset, offset + file.length);
    offset += file.length;
  }
  return { document, files };
}

function markdownArgs({ katex, callouts }, citations) {
  let extensions =
    // handles highlights ==e.g.==
    "+mark" +
    // resolves issue with html tags in markdown producing extra <p> tags
    // (see build/converters/markdown/tests/examples/mix-of-html-and-markdown.txt)
    "-native_divs" +
    // Add support for nice fenced divs e.g. ::: info
    "+fenced_divs" +
    // replace url strings with a tags
    "+autolink_bare_uris" +
    // wikilinks
    "+wikilinks_title_after_pipe" +
    // Breaks horizontal rules without blank lines between them
    "-simple_tables" +
    "-multiline_tables" +
    // Leave raw TeX alone so the KaTeX plugin can render math consistently
    // across all text converters.
    "-raw_tex" +
    // This sometimes throws errors for some reason
    "-yaml_metadata_block" +
    // Don't generate figures automatically
    "-implicit_figures" +
    // These otherwise require a blank line before them
    "+lists_without_preceding_blankline" +
    "-blank_before_header" +
    "-blank_before_blockquote";

  // Only consume dollar-delimited math when it will be rendered server-side.
  // Otherwise pandoc treats the dollars as ordinary text, preserving them for
  // client-side renderers such as MathJax.
  extensions += katex ? "+tex_math_dollars" : "-tex_math_dollars";

  // This feature breaks [@twitter]() links
  if (!citations) extensions += "-citations";

  const args = [
    "-f",
    "markdown" + extensions,
    "-t",
    "html5",
    // Don't declare widths for tables: https://github.com/jgm/pandoc/issues/2574
    "--columns",
    "1000",
    // we use our own highlighting library (hljs) later
    "--no-highlight",
    "--email-obfuscation=none",
  ];

  // Emit span.math with raw TeX for the KaTeX plugin. Without --standalone,
  // this does not add CDN script or link tags.
  if (katex) args.push("--katex");
  if (callouts) args.push("--lua-filter", path.join(__dirname, "callouts.lua"));
  return args;
}

// pandoc's arguments, after its heap limit, and whether the document is a file
function pandocArgs(options, dir, files) {
  const { from } = options;

  if (from === "docx" || from === "odt") {
    return [
      path.join(dir, "input." + from),
      "--extract-media=" + path.join(dir, "media"),
      "-f",
      from,
      "-t",
      "html5",
      // Standalone, for the title block the docx and odt converters read
      // ("header h1"), with a template of only that and the body: pandoc's
      // default one adds 10-25ms of head and CSS that the converters throw away
      "--template=" + path.join(__dirname, "title-only.html"),
    ];
  }

  if (from === "rtf" || from === "org") {
    return [
      "-f",
      from,
      "-t",
      "html5",
      "--no-highlight",
      // Keep this aligned with the other pandoc converters. The RTF reader
      // does not create Math nodes from dollar-delimited TeX, so the rtf
      // converter normalizes its literal output while the TeX is still there.
      "--katex",
      "--email-obfuscation=none",
    ];
  }

  const args = markdownArgs(options, Boolean(files.bibliography || files.csl));
  if (files.bibliography)
    args.push(
      "-M",
      "bibliography=" +
        path.join(dir, "bibliography" + options.bibliography.extension)
    );
  if (files.csl)
    args.push("-M", "csl=" + path.join(dir, "style" + options.csl.extension));
  if (files.bibliography || files.csl) args.push("--citeproc");
  return args;
}

function pandoc(args, stdin) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    // A pipe for every stream: "ignore" opens /dev/null, which the jail doesn't
    // have. The environment is the jail's, or the app's in-process.
    const child = spawn(
      pandocPath(),
      ["+RTS", "-M" + MAX_HEAP, "-RTS"].concat(args),
      {
        stdio: "pipe",
      }
    );
    const stdout = [];
    let stdoutSize = 0;
    let stderr = "";
    let timedOut = false;
    let failed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    const fail = (err) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(err);
    };

    child.on("error", fail);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > MAX_OUTPUT)
        return fail(new Error("pandoc output too large"));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR)
        stderr += chunk.toString().slice(0, MAX_STDERR - stderr.length);
    });
    child.on("close", (code, signal) => {
      if (failed) return;
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code === 0) return resolve({ html: Buffer.concat(stdout) });
      resolve({ error: { code, signal, timedOut, ms, stderr } });
    });
    child.stdin.end(stdin);
  });
}

// Every regular file under dir, as paths relative to it with / between parts
async function walk(dir, prefix = "") {
  const found = [];
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(dir, prefix), {
      withFileTypes: true,
    });
  } catch (err) {
    if (err.code === "ENOENT") return found;
    throw err;
  }
  for (const entry of entries) {
    const name = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) found.push(...(await walk(dir, name)));
    else if (entry.isFile()) found.push(name);
    if (found.length > MAX_MEDIA) throw new Error("too many media files");
  }
  return found;
}

async function run(args, input) {
  const options = check(args);
  const { document, files } = split(input, options);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pandoc-"));

  try {
    if (files.bibliography) {
      await fs.promises.writeFile(
        path.join(dir, "bibliography" + options.bibliography.extension),
        files.bibliography
      );
    }
    if (files.csl)
      await fs.promises.writeFile(
        path.join(dir, "style" + options.csl.extension),
        files.csl
      );

    const isFile = options.from === "docx" || options.from === "odt";
    if (isFile)
      await fs.promises.writeFile(
        path.join(dir, "input." + options.from),
        document
      );

    const result = await pandoc(
      pandocArgs(options, dir, files),
      isFile ? "" : document
    );
    if (result.error) return { meta: { error: result.error }, outputs: [] };

    const mediaDir = path.join(dir, "media");
    const media = await walk(mediaDir);
    const outputs = [result.html];
    for (const name of media)
      outputs.push(await fs.promises.readFile(path.join(mediaDir, name)));
    return { meta: { dir: mediaDir, media }, outputs };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { run, pandocPath };
