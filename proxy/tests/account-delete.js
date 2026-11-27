const fs = require("fs");
const path = require("path");

describe("proxy account deletion", function () {
  const contents = fs.readFileSync(
    path.join(__dirname, "../config/blot-site.conf"),
    "utf8"
  );
  const location =
    /location ~\* \^\/sites\/account\/subscription\/delete\(\/\|\$\) \{[\s\S]*?\n\}/;

  it("has its own case-insensitive location", function () {
    expect(contents).toMatch(location);
  });

  // Deletion takes folder locks, which belong in node-b (#2990)
  it("sends writes by method, so the POST goes to node-b", function () {
    const block = contents.match(location)[0];

    expect(block).toMatch(/ngx\.var\.dashboard_upstream/);
    expect(block).toMatch(/reverse-proxy-huge\.conf/);
  });

  it("comes before the /sites prefix location", function () {
    expect(contents.search(location)).toBeLessThan(
      contents.indexOf("location /sites {")
    );
  });
});
