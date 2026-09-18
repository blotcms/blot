const spawn = require("child_process").spawn;
const time = require("helper/time");
const config = require("config");
const Pandoc = config.pandoc.bin;
const debug = require("debug")("blot:converters:org");
const cheerio = require("cheerio");
const extractMetadata = require("build/metadata");
const loosenDisplayMath = require("build/math/loosenDisplayMath");

module.exports = function (blog, text, callback) {
  // Org always emits katex spans (see --katex below), so, as with the
  // markdown converter, display math ($$...$$) that occupies a whole
  // source line by itself but is glued to surrounding prose by a single
  // newline should still render as display rather than inline.
  try {
    text = loosenDisplayMath(text, { hardBreak: "\\\\" });
  } catch (e) {
    debug("loosenDisplayMath error", e.message || e.code, "caught safely");
  }

  var args = [
    // Limit the heap size for the pandoc process
    // to prevent pandoc consuming all the system's
    // memory in corner cases
    "+RTS",
    "-M" + config.pandoc.maxmemory,
    "-RTS",

    "-f",
    "org",

    // Not really sure what the difference is between
    // this and just HTML.
    "-t",
    "html5",

    // we use our own highlighint library (hljs) later
    "--no-highlight",

    // Emit span.math with raw TeX for the KaTeX plugin.
    "--katex",

    "--email-obfuscation=none"
  ];

  var startTime = Date.now();
  var pandoc = spawn(Pandoc, args);

  var result = "";
  var error = "";

  pandoc.stdout.on("data", function (data) {
    result += data;
  });

  pandoc.stderr.on("data", function (data) {
    error += data;
  });

  setTimeout(function () {
    pandoc.kill();
  }, config.pandoc.timeout);

  pandoc.on("close", function (code) {
    time.end("pandoc");

    var err = null;

    // This means something went wrong
    if (code !== 0) {
      err =
        "Pandoc exited with code " +
        code +
        " in " +
        (Date.now() - startTime) +
        "ms (timeout=" +
        config.pandoc.timeout +
        "ms)";
      err += error;
      err = new Error(err);
    }

    if (err) return callback(err);

    const $ = cheerio.load(
      result,
      {
        decodeEntities: false,
        xmlMode: true
      },
      false
    );

    // if there is a pre tag with class="yaml"
    // at the very start of the document then extract its contents,
    // replace the pre tag with the following:
    // ---
    // $YAML
    // ---

    // if the first child is a pre tag with class="yaml"
    const firstChild = $(":root").first();
    const yaml =
      firstChild && firstChild.is("pre.yaml") ? firstChild.text() : "";

    if (yaml) {
      firstChild.remove();
    }

    let text = (yaml ? ["---", yaml.trim(), "---"].join("\n") : "") + $.html();

    const parsed = extractMetadata(text);

    debug("Final:", parsed.html);
    callback(null, parsed.html, parsed.metadata);
  });

  debug("Pre-pandoc", text);
  time("pandoc");
  pandoc.stdin.end(text, "utf8");
};
