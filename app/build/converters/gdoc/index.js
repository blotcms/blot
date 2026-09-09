const fs = require("fs-extra");
const ensure = require("helper/ensure");
const LocalPath = require("helper/localPath");
const extname = require("path").extname;
const cheerio = require("cheerio");
const Metadata = require("build/metadata");
const extend = require("helper/extend");
const yaml = require("yaml");
const postSourceSize = require("build/converters/post-source-size");

const blockquotes = require("./blockquotes");
const footnotes = require("./footnotes");
const linebreaks = require("./linebreaks");
const restoreDisplayMath = require("./restore-display-math");
const processImages = require("./images");
const cleanupSpans = require("./cleanup-spans");
const { normalizeLiteralDollarMath } = require("build/math/normalizeLiteralDollars");

function textWithLineBreaks($, node) {
  const clonedNode = $(node).clone();
  clonedNode.find("br").replaceWith("\n");
  return clonedNode.text();
}

function extractTableCellCode($, cell) {
  const paragraphs = $(cell).find("p");

  if (paragraphs.length > 0) {
    return paragraphs
      .map(function () {
        return textWithLineBreaks($, this);
      })
      .get()
      .join("\n");
  }

  return textWithLineBreaks($, cell);
}

function convertCodeTables($) {
  $("table").each(function () {
    const table = $(this);
    const rows = table.find("tr");
    const cells = table.find("td");

    // Single-cell table (1x1): convert the lone cell into code block
    if (rows.length === 1 && cells.length === 1) {
      const code = extractTableCellCode($, cells[0]);
      const pre = $("<pre><code></code></pre>");
      pre.find("code").text(code);
      table.replaceWith(pre);
      return;
    }

    // Two-cell vertical table (2x1): first cell is language, second is code
    if (rows.length === 2 && cells.length === 2) {
      const language = extractTableCellCode($, cells[0]).trim();
      const code = extractTableCellCode($, cells[1]);
      const pre = $("<pre><code></code></pre>");
      const codeNode = pre.find("code");

      if (language) {
        pre.attr("class", language);
      }

      codeNode.text(code);
      table.replaceWith(pre);
    }
  });
}

function is(path) {
  return [".gdoc"].indexOf(extname(path).toLowerCase()) > -1;
}

async function read(blog, path, callback) {
  ensure(blog, "object").and(path, "string").and(callback, "function");

  try {
    const localPath = LocalPath(blog.id, path);

    const stat = await fs.stat(localPath);

    // Don't try and turn HTML exported from a Google Doc into posts if it's
    // over the limit — surface the same structured TOO_LARGE error the other
    // converters use so sync ignores it and the dashboard explains why.
    if (stat.size > postSourceSize.GDOC.bytes)
      return callback(postSourceSize.tooLargeError(postSourceSize.GDOC));

    const contents = await fs.readFile(localPath, "utf-8");

    const $ = cheerio.load(contents, { decodeEntities: false });

    // replaces google docs 'titles' with true h1 tags
    $("p.title").each(function (i, elem) {
      $(this).replaceWith("<h1>" + $(this).html() + "</h1>");
    });

    // replaces google docs 'subtitles' with true h2 tags
    $("p.subtitle").each(function (i, elem) {
      $(this).replaceWith("<h2>" + $(this).html() + "</h2>");
    });

    var metadata = {};

    // restore the original URL of all links and strip Google's nasty tracking
    // redirect e.g. map https://www.google.com/url?q=https://example.com&amp;sa=D&amp;source=editors&amp;ust=1751016887642460&amp;usg=AOvVaw05ZCiUPYVBgPd61MWsgljs -> https://example.com
    $("a").each(function (i, elem) {
      var href = $(this).attr("href");
      // parse the URL to get the original URL and ensure the current url host is 'google.com'
      var url = new URL(href, "https://example.com");
      if (url.hostname === "www.google.com" && url.searchParams.has("q")) {
        var originalUrl = url.searchParams.get("q");
        if (originalUrl) {
          $(this).attr("href", originalUrl);
        }
      }
    });

    let yamlOpeningTag;

    // parse metadata from paragraphs
    $("p").each(function (i) {
      var text = $(this).text();

      // If the first paragraph is a YAML front matter opening tag
      // then we should remove it if and only if the next paragraph
      // contains a valid YAML key-value pair.
      if ((text.trim() === "---" || text.trim() === "—") && i === 0) {
        yamlOpeningTag = $(this);
        return;
      }

      if (
        Object.keys(metadata).length > 0 &&
        (text.trim() === "---" || text.trim() === "—")
      ) {
        // this is a closing tag, so we should stop parsing metadata
        $(this).remove();
        return false;
      }

      if (text.indexOf(":") === -1) return false;

      var key = text.slice(0, text.indexOf(":"));

      // Key has space
      if (/\s/.test(key.trim())) return false;

      var parsed = Metadata(text);

      if (parsed.html === text) return false;

      extend(metadata).and(parsed.metadata);

      // Since we have a valid YAML front matter opening tag,
      // we should also check for a closing tag.
      if (yamlOpeningTag && i === 1) {
        yamlOpeningTag.remove();
        validYAML = true;
      }

      $(this).remove();
    });

    // remove all empty spans
    $('span:empty').remove();

    // replace italic inlines with em
    $('span[style*="font-style:italic"]').each(function (i, elem) {
      $(this).replaceWith("<em>" + $(this).html() + "</em>");
    });

    // replace bold inlines with strong
    $('span[style*="font-weight:700"]').each(function (i, elem) {
      $(this).replaceWith("<strong>" + $(this).html() + "</strong>");
    });

    // replace superscript inlines with sup
    $('span[style*="vertical-align:super"]').each(function (i, elem) {
      $(this).replaceWith("<sup>" + $(this).html() + "</sup>");
    });

    // replace subscript inlines with sub
    $('span[style*="vertical-align:sub"]').each(function (i, elem) {
      $(this).replaceWith("<sub>" + $(this).html() + "</sub>");
    });

    // replace underline inlines with u
    $('span[style*="text-decoration:underline"]').each(function (i, elem) {
      // if this contains a link, skip
      if ($(this).find('a').length > 0) {
        return;
      }
      $(this).replaceWith("<u>" + $(this).html() + "</u>");
    });

    // replace strikethrough inlines with strike
    $('span[style*="text-decoration:line-through"]').each(function (i, elem) {
      $(this).replaceWith("<strike>" + $(this).html() + "</strike>");
    });

    // wrap contents of li with strike in <strike> tag
    $('li[style*="text-decoration:line-through"]').each(function (i, elem) {
      $(this).wrapInner("<strike>" + $(this).html() + "</strike>");
    });
    
    // remove all inline style attributes
    $("[style]").removeAttr("style");

    cleanupSpans($);

    // handle line breaks
    linebreaks($);

    await processImages(blog.id, path, $);

    // handle blockquotes
    blockquotes($);

    // restore display math whose Google Docs paragraphs were joined above
    // this runs after blockquotes so that an equation inside a quote is
    // recognized once its quote markers have been removed
    restoreDisplayMath($);

    // handle footnotes
    footnotes($);

    // transform code tables before final serialization
    convertCodeTables($);

    normalizeLiteralDollarMath($);

    let html = $("body").html();

    if (Object.keys(metadata).length > 0) {
      html = "---\n" + yaml.stringify(metadata) + "---\n" + html;
    }

    // make output more readable by inserting new lines after block elements
    // handle hr and br separately as it is self-closing
    html = html
      .replace(/<\/(h1|h2|h3|h4|h5|h6|p|blockquote|ul|ol|li)>/g, "</$1>\n")
      .replace(/<(hr|br)[^>]*>/g, "<$1>\n")
      .trim();

    callback(null, html, stat);
  } catch (err) {
    callback(err);
  }
}

module.exports = { read: read, is: is, id: "gdoc" };
