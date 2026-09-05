const fs = require("fs");
const path = require("path");

describe("zine entries index wrapping", function () {
  const html = fs.readFileSync(
    path.join(__dirname, "../source/zine/entries.html"),
    "utf8"
  );
  const css = fs.readFileSync(
    path.join(__dirname, "../source/zine/style.css"),
    "utf8"
  );

  const entryMarkup = html.match(/\{\{#posts\}\}([\s\S]*?)\{\{\/posts\}\}/)[1];

  it("keeps each date on one line", function () {
    expect(css).toMatch(
      /\.entries \.entry-date\s*\{[^}]*white-space:\s*nowrap/
    );
  });

  it("allows wrapping between the title and the date", function () {
    expect(entryMarkup).toMatch(/<\/a\s*> <span class="entry-date"/);
    expect(entryMarkup).not.toMatch(/&nbsp;/);
  });
});
