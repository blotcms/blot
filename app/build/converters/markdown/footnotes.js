var cheerio = require("cheerio");
var makeUid = require("helper/makeUid");

module.exports = function (html) {
  // Only a ".footnotes" element is rewritten (decodeEntities is off, so the
  // class can only match if the literal word is present). Skip parsing the
  // whole document for the common case of a post without footnotes.
  if (html.indexOf("footnotes") === -1) return html;

  var $ = cheerio.load(html, { decodeEntities: false }, false);

  var changes = false;
  var postfix = makeUid(3);

  // Index links and ids once, rather than running three whole-document
  // selector queries per footnote (quadratic in the number of footnotes).
  // Each lookup re-checks the element's current attribute, so the result
  // matches what a live selector query would have returned.
  var linksByHref = Object.create(null);
  var elementsById = Object.create(null);

  $("a[href]").each(function () {
    var href = $(this).attr("href");
    (linksByHref[href] || (linksByHref[href] = [])).push(this);
  });

  $("[id]").each(function () {
    var id = $(this).attr("id");
    (elementsById[id] || (elementsById[id] = [])).push(this);
  });

  // Anything that is not a plain identifier keeps the original selector
  // query, so odd ids behave exactly as before.
  var PLAIN = /^[\w-]+$/;

  function links(href) {
    if (!PLAIN.test(href.slice(1))) return $('a[href="' + href + '"]');
    return $(
      (linksByHref[href] || []).filter(function (el) {
        return $(el).attr("href") === href;
      })
    );
  }

  function byId(id) {
    if (!PLAIN.test(id)) return $("#" + id);
    return $(
      (elementsById[id] || []).filter(function (el) {
        return $(el).attr("id") === id;
      })
    );
  }

  // The purpose of this is to prefix all the links
  // and IDs which start with #fn... so that
  // multiple entries with footnotes work nicely
  // on the same page.
  $(".footnotes ol li").each(function () {
    changes = true;

    var noteID = $(this).attr("id");

    // Sometimes people make their own footnotes...
    // the colon fucks with cheerio so I just ignore
    // note identifiers if they have them. Pandoc
    // never makes note identifiers with colons.
    if (!noteID || noteID.indexOf(":") > -1 || noteID.slice(0, 2) !== "fn") {
      return;
    }

    var id = noteID.slice("fn".length);
    var refID = "fnref" + id;

    var newNoteID = "footnote-" + id + postfix;
    var newRefID = "ref-" + id + postfix;

    $(this).attr("id", newNoteID);

    links("#" + noteID)
      .removeClass("footnoteRef")
      .addClass("footnote-ref")
      .attr("href", "#" + newNoteID);

    links("#" + refID)
      .attr("href", "#" + newRefID)
      .addClass("footnote-back");

    byId(refID).attr("id", newRefID);
  });

  return changes ? $.html() : html;
};
