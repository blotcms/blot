var debug = require("debug")("blot:build:prepare:teaser");
// Some of these characters are different, though they look the same...
// Lines 5 - 24 should be removed, if I work out how to consolidate
// escaped chars?
// I should probably just escape the contents of each text node automatically?
// Then it's important that code and pre and other is ignored...
var invisible = ["h1", "h2", "h3", "h4", "h5", "h6", "script", "style"];
var cheerio = require("cheerio");

var breakPoints = [
  "<< more >>",
  "{{more}}",
  "<<more>>",
  "<!-- more -->",
  "<!- more ->",
  "<!— more —>"
];
var charMap = {
  "<": "&lt;",
  ">": "&gt;",
  "-": "&#x2014;"
};

for (var x in breakPoints) {
  var newBP = breakPoints[x];

  for (var y in charMap) {
    if (newBP.indexOf(y) > -1) {
      newBP = newBP.split(y).join(charMap[y]);
      if (newBP !== breakPoints[x]) breakPoints.push(newBP);
    }
  }
}

function removeNextSiblings (node, $) {
  if (!node) return;

  // Remove this node's siblings...
  var nextSibling = node.next;

  while (nextSibling) {
    $(nextSibling).remove();
    nextSibling = nextSibling.next;
  }

  // Back up...
  $(node).nextAll().remove();
}

function makeTeaser (html) {
  debug("loading HTML");

  var $ = cheerio.load(
    html,
    {
      decodeEntities: false
    },
    false
  );

  debug("loaded HTML");

  // Cache the html passed
  // so we can chech if
  // there is stuff after the teaser
  debug("caching HTML");
  var _html = $.html();
  debug("cached HTML");

  var root = $.root();

  // Flag to use so we can determine
  // whether to create a teaser automatically
  // as opposed to a breakpoint inserterd by the user
  var foundABreakPoint;

  debug("looking for breakpoints...");
  root.contents().each(function doLook (i, node) {
    // WE NEED TO IGNORE CERTAIN NODES NOW
    // E.G. CODE, PRE, STYLE
    if ($(this).parents().filter("code, head, pre, script, style").length) {
      debug("should skip this tag");
      return;
    }

    // This node is itself the breakpoint
    // or contains a breakPoint in its text content
    if (isBreakPoint(node) || containsBreakPoint(node)) {
      debug("found a breakpoint!");

      // We care about the earliest breakpoint we find
      // and no more
      if (foundABreakPoint) return false;

      foundABreakPoint = true;

      // We cache the next node
      // and the parent node of the breakpoint
      // so we can use them after removing
      // the breakpoint node itself
      var next = node.next;
      var parent = node.parent;

      // We remove the breakpoint, calculate
      // the new HTML then proceed to strip the rest
      // of the HTML after the breakpoint
      if (containsBreakPoint(node)) {
        node.data = stripOtherText(node)[0];
      }

      if (isBreakPoint(node)) {
        $(node).remove();
      }

      // Now we remove the breakpoint node's next siblings
      removeNextSiblings(next, $);
      $(next).remove();

      // Finally we remove the next siblings of each of the
      // breakpoint node's parents. This ensures that all
      // content 'after' the breakpoint is stripped.
      while (parent) {
        removeNextSiblings(parent, $);
        parent = parent.parent;
      }

      // We didn't find a breakpoint yet so recurse down each child...
    } else if ($(this).contents() && $(this).contents().length) {
      debug("going deeper");
      $(this).contents().each(doLook);
    }
  });

  // Since we didn't find a manual breakpoint
  // we need to do things automatically
  if (!foundABreakPoint) {
    debug("did not find a breakpoint!");

    var MAXCHILDREN = 3;
    var index = 0;

    // Remove everything after the third node
    // remember i is zero indexed...
    root.contents().each(function () {
      if (index > MAXCHILDREN) return $(this).remove();

      if (invisible.indexOf(this.name) > -1) return;

      index++;
    });
  }

  var teaserHTML = $.html();

  if (teaserHTML.trim() === _html) {
    return false;
  }

  return teaserHTML;
}

function isBreakPoint (node) {
  var content;

  if (node.children && node.children[0] && node.children[0].data) {
    content = node.children[0].data.trim().toLowerCase();

    if (breakPoints.indexOf(content) > -1) return true;
  }

  if (node.data === undefined) return false;

  content = node.data.trim().toLowerCase();

  // Comment NODES
  // <!-- more --> and <!-- MORE --> etc...
  if (node.type === "comment" && content === "more") return true;

  // Text node soley contains breakpoint string
  // the breakpoint node needs to be this node's parent
  // (i.e. the node which contains this text)
  if (node.type === "text" && breakPoints.indexOf(content) > -1) return true;
}

function containsBreakPoint (node) {
  if (node.data === undefined || node.type !== "text") return false;

  var content = node.data.trim().toLowerCase();

  // Text node contains breakpoint string
  // as well as other text
  for (var i in breakPoints)
    if (content.indexOf(breakPoints[i]) > -1) return true;
}

function stripOtherText (node) {
  var content = node.data.trim().toLowerCase(),
    data = node.data,
    dataWithoutBreakPoint,
    dataStripped;

  for (var x in breakPoints) {
    if (content.indexOf(breakPoints[x]) > -1) {
      var i = content.indexOf(breakPoints[x]);

      dataStripped = data.slice(0, i);
      dataWithoutBreakPoint =
        data.slice(0, i) + data.slice(i + breakPoints[x].length);

      return [dataStripped, dataWithoutBreakPoint];
    }
  }
}

// Returns the HTML with the first breakpoint marker removed and all
// content kept. Called after the teaser is calculated so the marker
// does not leak into the rendered entry.
var markerPatterns = breakPoints.map(function (marker) {
  return new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
});

var invisibleToMarker = ["code", "head", "pre", "script", "style"];

function stripBreakPoint (html) {
  // Cheap precheck: every marker contains "more"
  if (!html || !/more/i.test(html)) return html;

  var $ = cheerio.load(html, { decodeEntities: false }, false);
  var found = false;

  function earliestMarker (text) {
    var best = null;

    // Search the original string: lowercasing can change its length
    markerPatterns.forEach(function (pattern) {
      var m = pattern.exec(text);
      if (m && (!best || m.index < best.index || (m.index === best.index && m[0].length > best.length)))
        best = { index: m.index, length: m[0].length };
    });

    return best;
  }

  function walk (nodes) {
    nodes.each(function (i, node) {
      if (found) return false;

      if (node.type === "comment") {
        if (node.data.trim().toLowerCase() === "more") {
          found = true;
          $(node).remove();
        }
      } else if (node.type === "text") {
        var marker = earliestMarker(node.data);
        if (!marker) return;

        found = true;
        node.data =
          node.data.slice(0, marker.index) +
          node.data.slice(marker.index + marker.length);

        // The marker was the only content of its element (e.g. <p>{{more}}</p>)
        var parent = node.parent;
        if (
          !node.data.trim() &&
          parent &&
          parent.type === "tag" &&
          parent.children.length === 1
        )
          $(parent).remove();
      } else if (node.type === "tag" && invisibleToMarker.indexOf(node.name) === -1) {
        walk($(node).contents());
      }
    });
  }

  walk($.root().contents());

  return found ? $.html() : html;
}

makeTeaser.stripBreakPoint = stripBreakPoint;

module.exports = makeTeaser;
