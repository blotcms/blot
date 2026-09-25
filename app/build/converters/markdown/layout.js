var tags = buildTags("{}", {
  "<>": "wide",
  "<<": "wide left",
  ">>": "wide right",
  "<": "left inside",
  ">": "right inside",
  ">|": "left margin",
  "|<": "right margin",
  "||": "two column",
  "|||": "three column",
  "||||": "four column",
});

var start = function (tag) {
  return '<div class="' + tags[tag] + '">\n';
};

var END = "\n</div>";

// Should we really add the clear?
// Is it strictly neccessary?

// What if we want to float something left inside?
var CLEAR = '\n<div class="clear"></div>';
var FOUR_SPACES = "    ";

function hasIndent(line) {
  return line.indexOf("\t") === 0 || line.indexOf(FOUR_SPACES) === 0;
}

// if there is additional indentation, try to add fencing so pre is preserved?

function trimLeading(str) {
  return str.slice(str.indexOf(str.trim()));
}

function layout(text) {
  // {<>} Foo
  //      Bar

  // {||} A column

  var lines = text.split("\n");
  var totalLines = lines.length;

  for (var i = 0; i < totalLines; i++) {
    var line = lines[i];
    var tag = hasTag(line);

    if (!tag) continue;

    // If the next line is indented by a tab, or four or five
    // spaces then merge it into this tag
    for (var y = i + 1; y < totalLines; y++) {
      var nextLine = lines[y];

      if (!hasIndent(nextLine)) break;

      line += "\n" + trimLeading(nextLine);
      lines.splice(y, 1);
      y--;
      totalLines--;
    }

    line = trimLeading(line.slice(tag.length));
    line = start(tag) + line + END;
    lines[i] = line;

    if (isColumn(tag)) {
      // CLEAR if the next non-blank line is NOT a column
      for (var x = i + 1; x < totalLines; x++) {
        if (lines[x].trim() === "") continue;

        if (isColumn(hasTag(lines[x]))) break;

        lines[i] += CLEAR;
        break;
      }
    }
  }

  text = lines.join("\n");

  return text;
}

function escape(str) {
  return str.split("<").join("&lt;").split(">").join("&gt;");
}

function hasTag(line) {
  var tag = null;

  for (var x in tags) if (line.indexOf(x) === 0) tag = x;

  return tag;
}

function isColumn(tag) {
  return tags[tag] && tags[tag].indexOf("column") > -1;
}

function buildTags(wrapper, tags) {
  var start = wrapper[0];
  var end = wrapper[1];

  for (var i in tags) {
    var tag = start + i + end;

    tags[tag] = tags[escape(tag)] = tags[i];

    delete tags[i];
  }

  return tags;
}

module.exports = layout;
