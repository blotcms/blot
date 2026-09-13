var spawn = require("child_process").spawn;
var path = require("path");
var indentation = require("./indentation");
var footnotes = require("./footnotes");
var time = require("helper/time");
var config = require("config");
var Pandoc = config.pandoc.bin;
var debug = require("debug")("blot:converters:markdown");

// insert a <br /> for each carriage return
// '+hard_line_breaks' +

module.exports = function (blog, text, options, callback) {
  var katexEnabled = Boolean(
    blog.plugins && blog.plugins.katex && blog.plugins.katex.enabled
  );
  var extensions =

    // handles highlights ==e.g.==
    '+mark' +
    
    // resolves issue with html tags in markdown
    // producing extra <p> tags (see ./tests/examples/mix-of-html-and-markdown.txt)
    "-native_divs" +

    // Add support for nice fenced divs e.g. ::: info
    "+fenced_divs" +

    // replace url strings with a tags
    "+autolink_bare_uris" +
    // wikilinks
    "+wikilinks_title_after_pipe" +
    // Fucks up with using horizontal rules
    // without blank lines between them.
    "-simple_tables" +
    "-multiline_tables" +
    // Leave raw TeX alone so the KaTeX plugin can render math consistently
    // across all text converters.
    "-raw_tex" +
    // This sometimes throws errors for some reason
    "-yaml_metadata_block" +
    // Don't generate figures automatically
    "-implicit_figures" +
    // These require a blank line before shit
    "+lists_without_preceding_blankline" +
    "-blank_before_header" +
    "-blank_before_blockquote";

  // Only consume dollar-delimited math when it will be rendered server-side.
  // Otherwise Pandoc treats the dollars as ordinary text, preserving them for
  // client-side renderers such as MathJax.
  if (katexEnabled) { 
    extensions += "+tex_math_dollars";
  } else {
    extensions += "-tex_math_dollars";
  }

  // This feature fucks with [@twitter]() links
  // perhaps make it an option in future?
  if (!(options.bib || options.csl)) extensions += "-citations";

  var args = [
    // Limit the heap size for the pandoc process
    // to prevent pandoc consuming all the system's
    // memory in corner cases
    "+RTS",
    "-M" + config.pandoc.maxmemory,
    "-RTS",

    "-f",
    "markdown" + extensions,

    // Not really sure what the difference is between
    // this and just HTML.
    "-t",
    "html5",

    // Don't declare widths for tables
    // https://github.com/jgm/pandoc/issues/2574
    "--columns",
    "1000",

    // we use our own highlighint library (hljs) later
    "--no-highlight",

    // such a dumb default feature... sorry john!
    "--email-obfuscation=none",
  ];

  // Emit span.math with raw TeX for the KaTeX plugin. Without --standalone,
  // this does not add CDN script or link tags.
  if (katexEnabled) args.push("--katex");

  if (
    blog.plugins &&
    blog.plugins.callouts &&
    blog.plugins.callouts.enabled === true
  ) {
    args.push("--lua-filter");
    args.push(
      path.resolve(__dirname, "../../plugins/callouts/callouts.lua")
    );
  }

  if (options.bib) {
    args.push("-M");
    args.push("bibliography=" + options.bib);
  }

  if (options.csl) {
    args.push("-M");
    args.push("csl=" + options.csl);
  }

  if (options.bib || options.csl) {
    args.push("--citeproc");
  }

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

    debug("Pre-footnotes", result);
    time("footnotes");
    result = safely(footnotes, result);
    time.end("footnotes");

    debug("Final:", result);
    callback(null, result);
  });

  // Pandoc is very strict and treats indents inside
  // HTML blocks as code blocks. This is correct but
  // bad user experience. For instance this:
  //
  // <table>
  //     <td>[Hey!](/goo)</td>
  // </table>
  //
  // Becomes:
  //
  // <table>
  // <pre><code><td>[Hey!](/goo)</td></code></pre>
  // </table>
  //
  // This is obviously not desirable. But we want to
  // mix HTML and Markdown in the same file. So I wrote
  // a little script to collapse the indentation
  // for the contents of an HTML tag. This preserves
  // indentation in text! More discussion of this issue:
  // https://github.com/jgm/pandoc/issues/1841
  debug("Pre-indentation", text);
  time("indentation");
  text = safely(indentation, text);
  time.end("indentation");

  debug("Pre-pandoc", text);
  time("pandoc");
  pandoc.stdin.end(text, "utf8");
};

function safely(method, input) {
  try {
    input = method(input);
  } catch (e) {
    debug("Conversion Error:", e.message || e.code, "caught safely");
    if (e.stack) debug(e.stack);
  }

  return input;
}
