async function render($) {
  $("img").each(function () {
    var altText = $(this).attr("title") || $(this).attr("alt");

    if (!altText) return;

    var ignore;

    if ($(this).hasClass("emoji")) return;

    // Ignore images inside paragraphs.
    $(this)
      .parent()
      .contents()
      .each(function () {
        // Other captions are fine.
        if ($(this).is(".caption, img")) return;

        if ($(this).text().trim().length) {
          ignore = true;
        }
      });

    if (ignore) return;

    // This should probably replaced with figure
    // or at least caption should be a block level
    // element. This wraps awkwardly with small images

    if ($(this).parent().hasClass("image")) {
      $(this)
        .parent()
        .after('<span class="caption">' + altText + "</span>");
    } else {
      $(this).after('<span class="caption">' + altText + "</span>");
    }
  });
}

module.exports = {
  render,
  category: "images",
  isDefault: true,
  title: "Caption",
  description: "Create captions from alt text",
};
