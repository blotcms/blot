module.exports = function footnotes($) {
  if (!$ || typeof $.root !== "function") return;

  const footnoteDefs = [];

  $("a[id^='ftnt']").each(function () {
    const id = $(this).attr("id") || "";

    if (!id || id.indexOf("ftnt_ref") === 0) return;

    const href = $(this).attr("href") || "";
    const referencedId = href.replace(/^#/, "");
    const numberMatch = id.match(/ftnt(\d+)/);
    const numberFromHref = referencedId.replace(/ftnt_ref/, "");
    const number = (numberMatch && numberMatch[1]) || numberFromHref;

    if (!number) return;

    const paragraph = $(this).closest("p");
    if (!paragraph.length) return;

    const clone = paragraph.clone();

    clone.find("a[id^='ftnt']").remove();
    clone.find("a[href^='#ftnt_ref']").remove();

    const firstContent = clone
      .contents()
      .filter(function () {
        return this.type !== "comment";
      })
      .first();

    if (firstContent && firstContent.length) {
      if (firstContent[0].type === "text") {
        firstContent[0].data = firstContent[0].data.replace(/^[\s\u00a0]+/, "");
      } else if (firstContent[0].type === "tag") {
        const text = firstContent.text();
        const trimmed = text.replace(/^[\s\u00a0]+/, "");
        if (trimmed !== text) {
          firstContent.text(trimmed);
        }
      }
    }

    let html = clone.html() || "";

    // Note: empty spans are already cleaned up by cleanupSpans()
    html = html.replace(/&nbsp;/gi, " ").trim();

    footnoteDefs.push({
      number,
      refId: referencedId,
      html,
      paragraph,
    });
  });

  if (!footnoteDefs.length) return;

  // Remove the original footnote paragraphs and any immediately preceding hr.
  footnoteDefs.forEach(({ paragraph }) => {
    const parent = paragraph.parent();

    if (parent && parent.prev().is("hr")) {
      parent.prev().remove();
    }

    paragraph.remove();

    if (parent && !parent.html().trim()) {
      parent.remove();
    }
  });

  const section = $("<section>")
    .attr("id", "footnotes")
    .addClass("footnotes footnotes-end-of-document")
    .attr("role", "doc-endnotes");

  section.append("<hr>");

  const list = $("<ol>");

  footnoteDefs
    .sort((a, b) => Number(a.number) - Number(b.number))
    .forEach(({ number, refId, html }) => {
      const noteId = `footnote-${number}`;
      const refElement = refId ? $("#" + refId) : null;
      let label = number;

      if (refElement && refElement.length) {
        const refText = refElement.text();
        const match = refText.match(/\d+/);
        if (match) label = match[0];

        const sup = refElement.parent("sup");
        const footnoteRef = $("<a>")
          .attr("href", `#${noteId}`)
          .attr("id", `ref-${number}`)
          .attr("role", "doc-noteref")
          .addClass("footnote-ref")
          .append($("<sup>").text(label));

        if (sup.length) {
          sup.replaceWith(footnoteRef);
        } else {
          refElement.replaceWith(footnoteRef);
        }
      }

      const listItem = $("<li>").attr("id", noteId);
      const paragraph = $("<p>");

      if (html) {
        paragraph.html(html);
      }

      paragraph.append(
        $("<a>")
          .attr("href", `#ref-${number}`)
          .attr("role", "doc-backlink")
          .addClass("footnote-back")
          .text("↩︎")
      );

      listItem.append(paragraph);
      list.append(listItem);
    });

  section.append(list);

  $("body").append(section);
};
