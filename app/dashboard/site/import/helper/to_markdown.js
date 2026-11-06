var Turndown = require("turndown");
var turndown = new Turndown();
var pretty = require("pretty");

// Themes like figures!
turndown.keep(["figure"]);

function by_class(name) {
  return function (node) {
    return (
      node.getAttribute("class") &&
      node.getAttribute("class").indexOf(name) > -1
    );
  };
}

turndown.addRule("further-reading-image", {
  filter: by_class("bookimage"),
  replacement: function (content) {
    return "{<} " + content;
  },
});

turndown.addRule("further-reading-description", {
  filter: by_class("bookdes"),
  replacement: function (content) {
    return "_" + content + "_";
  },
});

turndown.addRule("pretty-figures", {
  filter: function (node) {
    return node.nodeName === "FIGURE";
  },
  replacement: function (content, node) {
    // for (var i in node)
    //   console.log(i);

    // console.log(node.innerHTML,);

    // throw '';

    return pretty(node.outerHTML) + "\n\n";
  },
});

// THis is a good anchor pattern to try
// via http://bigfootjs.com/
// /(fn|footnote|note)[:\-_\d]/gi

// Try and reverse the footnotes!
turndown.addRule("keep-footnotes-note", {
  filter: function (node) {
    if (node.nodeName !== "SUP") return false;

    var id, footnote_id;

    id = node.getAttribute("id") || "";
    footnote_id = parseInt(id.slice(2));

    return id && !isNaN(footnote_id) && id.slice(0, 2) === "fn";
  },

  replacement: function (content, node) {
    var footnote_id = parseInt(node.getAttribute("id").slice(2));

    // Remove leading number
    content = content.slice(content.indexOf(".") + 1);

    // Remove trailing return link
    content = content.slice(0, content.indexOf("[↩]"));

    return "[^" + footnote_id + "]: " + content.trim();
  },
});

turndown.addRule("keep-footnotes-ref", {
  filter: function (node) {
    if (node.nodeName !== "A") return false;

    var href, footnote_id;

    href = node.getAttribute("href") || "";
    footnote_id = parseInt(href.slice(3));

    return href[0] === "#" && href.slice(1, 3) === "fn" && !isNaN(footnote_id);
  },

  replacement: function (content, node) {
    return "[^" + parseInt(node.getAttribute("href").slice(3)) + "]";
  },
});

// This is a heauristic
function isAlreadyMarkdown(html) {
  var hasLinks = /\[[^]+\]\([^]+\)/.test(html);
  var hasEmphasis = /[_*][^]+[_*]/.test(html);
  var hasTitles = /^[#]+ [^\n\r]*$/.test(html);

  return hasLinks || hasEmphasis || hasTitles;
}

module.exports = function (html) {
  if (isAlreadyMarkdown(html)) {
    return html;
  }

  var markdown;

  markdown = turndown.turndown(html);

  markdown = markdown.trim();

  markdown = markdown.split("\n\n  \n\n").join("\n\n");

  // if (markdown.indexOf("\\_") > -1) {
  //   console.log(markdown);
  //   throw markdown;
  // }

  return markdown;
};
