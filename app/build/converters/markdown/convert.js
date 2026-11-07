var indentation = require("./indentation");
var footnotes = require("./footnotes");
var loosenDisplayMath = require("build/math/loosenDisplayMath");
var time = require("helper/time");
var pandoc = require("build/converters/pandoc");
var debug = require("debug")("blot:converters:markdown");

// insert a <br /> for each carriage return
// '+hard_line_breaks' +

async function convert(blog, text, options) {
  var katexEnabled = Boolean(
    blog.plugins && blog.plugins.katex && blog.plugins.katex.enabled
  );

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

  // Only display math that Pandoc will actually parse (i.e. when the katex
  // plugin is enabled) needs the hard-break treatment.
  if (katexEnabled) {
    text = safely(loosenDisplayMath, text);
  }

  debug("Pre-pandoc", text);
  time("pandoc");
  var output;

  try {
    output = await pandoc(
      {
        from: "markdown",
        katex: katexEnabled,
        callouts: Boolean(
          blog.plugins &&
          blog.plugins.callouts &&
          blog.plugins.callouts.enabled === true
        ),
      },
      Buffer.from(text, "utf8"),
      { bibliography: options.bib, csl: options.csl }
    );
  } finally {
    time.end("pandoc");
  }

  var result = output.html;

  debug("Pre-footnotes", result);
  time("footnotes");
  result = safely(footnotes, result);
  time.end("footnotes");

  debug("Final:", result);
  return result;
}

module.exports = convert;

function safely(method, input) {
  try {
    input = method(input);
  } catch (e) {
    debug("Conversion Error:", e.message || e.code, "caught safely");
    if (e.stack) debug(e.stack);
  }

  return input;
}
