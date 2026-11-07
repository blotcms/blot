var insert_video_embeds =
  require("dashboard/site/import/helper").insert_video_embeds;
var debug = require("debug")("blot:importer:wordpress:tidy");
var remove_inline_images = require("./remove_inline_images.js");

module.exports = function (entry) {
  var html = entry.html;

  html = fix_missing_p_tags(html);
  html = remove_caption(html);
  html = remove_embed(html);
  html = remove_inline_images(html);
  html = insert_video_embeds(html);

  entry.html = html;

  return entry;
};

function remove_caption(html) {
  while (html.indexOf("[caption") > -1) {
    var opening_index = html.indexOf("[caption");
    var remainder = html.slice(opening_index);
    var closing_index = remainder.indexOf("]");

    html =
      html.slice(0, opening_index) +
      html.slice(opening_index + closing_index + 1);
    html = html.split("[/caption]").join("");
  }

  return html;
}

function remove_embed(html) {
  while (html.indexOf("[embed") > -1) {
    var opening_index = html.indexOf("[embed");
    var remainder = html.slice(opening_index);
    var closing_index = remainder.indexOf("]");

    html =
      html.slice(0, opening_index) +
      html.slice(opening_index + closing_index + 1);
    html = html.split("[/embed]").join("");
  }

  return html;
}

function fix_missing_p_tags(html) {
  // HTML created by windows users contains /r instead of newlines
  // which breaks the following code
  html = html.split("\r").join("\n");

  // Check for the closing tag instead of the
  // opening tag to avoid matching <p> and <p id="..."> etc...
  var has_p_tag = html.indexOf("</p>") > -1;
  var doesnt_have_double_line_break = html.indexOf("\n\n") === -1;

  if (has_p_tag || doesnt_have_double_line_break) {
    if (has_p_tag)
      debug(
        "Not interserting missing <p> tags into HTML because it already has p tags"
      );
    if (doesnt_have_double_line_break)
      debug(
        "Not interserting missing <p> tags into HTML because it does not have double line breaks"
      );

    debug(JSON.stringify(html));

    return html;
  }

  // console.log('! Warning, replacing missing <p> tags.')
  // console.log('---- BEFORE');
  // console.log(html);
  // console.log('----');

  html = html.split("\n\n");
  html = html.map(function (line) {
    return "<p>" + line + "</p>";
  });
  html = html.join("\n\n");

  // console.log('---- AFTER');
  // console.log(html);
  // console.log('----');

  return html;
}
