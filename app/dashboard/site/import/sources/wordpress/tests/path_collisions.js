var fs = require("fs-extra");
var os = require("os");
var path = require("path");
var importWordpress = require("../index");

describe("wordpress import path collisions", function () {
  it("preserves both colliding entries in distinct files", function (done) {
    var directory = fs.mkdtempSync(path.join(os.tmpdir(), "wordpress-import-"));
    var source = path.join(directory, "export.xml");
    var output = path.join(directory, "output");
    var item = function (title, content) {
      return (
        "<item><title>" +
        title +
        "</title>" +
        "<link>https://example.com/post</link>" +
        "<pubDate>Tue, 04 Aug 2020 12:00:00 GMT</pubDate>" +
        "<content:encoded><![CDATA[<p>" +
        content +
        "</p>]]></content:encoded>" +
        "<wp:status>publish</wp:status><wp:post_type>post</wp:post_type></item>"
      );
    };
    var xml =
      '<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/" ' +
      'xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>' +
      "<title>Test</title><link>https://example.com</link><wp:wxr_version>1.2</wp:wxr_version>" +
      item("Collision!", "first body") +
      item("Collision?", "second body") +
      "</channel></rss>";

    fs.writeFileSync(source, xml);
    importWordpress(
      source,
      output,
      function () {},
      {},
      function (err) {
        if (err) return done.fail(err);
        var first = fs.readFileSync(
          path.join(output, "2020", "08-04-Collision.txt"),
          "utf8"
        );
        var second = fs.readFileSync(
          path.join(output, "2020", "08-04-Collision-2.txt"),
          "utf8"
        );
        expect(first).toContain("first body");
        expect(second).toContain("second body");
        fs.removeSync(directory);
        done();
      }
    );
  });
});
