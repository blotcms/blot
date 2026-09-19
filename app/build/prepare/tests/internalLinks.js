describe("internalLinks", function () {
  var cheerio = require("cheerio");
  var internalLinks = require("../internalLinks");
  var BLOT_CDN_TOKEN = require("../../../blog/render/replaceFolderLinks/cdnToken");

  beforeEach(function () {
    this.internalLinks = function (html, blogID) {
      var $ = cheerio.load(
        html,
        {
          decodeEntities: false,
          withDomLvl1: false // this may cause issues?
        },
        false
      );

      return internalLinks($, blogID);
    };
  });

  it("keeps canonical internal links", function () {
    expect(this.internalLinks('<a href="/hey">Hey</a>')).toEqual(["/hey"]);
  });

  it("ignores external links", function () {
    expect(this.internalLinks('<a href="https://example.com/hey">Hey</a>')).toEqual([]);
  });

  it("normalizes fragments and query strings to the base path", function () {
    expect(
      this.internalLinks(
        '<a href="/target#section">Section</a><a href="/target?x=1">Query</a><a href="/target?x=1#section">Both</a>'
      )
    ).toEqual(["/target"]);
  });

  it("deduplicates across canonical and variant internal links", function () {
    expect(
      this.internalLinks(
        '<a href="/target">Base</a><a href="/target#x">Fragment</a><a href="/target?y=1">Query</a>'
      )
    ).toEqual(["/target"]);
  });

  it("recovers the original path from a link baked by app/build/plugins/folderAssets", function () {
    var blogID = "blog_abc123";
    var baked = `${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}/photo.jpg`;

    expect(
      this.internalLinks(`<a href="${baked}">Photo</a>`, blogID)
    ).toEqual(["/photo.jpg"]);
  });

  it("normalizes fragments and query strings on a baked link", function () {
    var blogID = "blog_abc123";
    var baked = `${BLOT_CDN_TOKEN}/folder/v-deadbeef/${blogID}/target?x=1#section`;

    expect(
      this.internalLinks(`<a href="${baked}">Target</a>`, blogID)
    ).toEqual(["/target"]);
  });

  it("ignores a baked link when no blogID is provided", function () {
    var baked = `${BLOT_CDN_TOKEN}/folder/v-deadbeef/blog_abc123/photo.jpg`;

    expect(this.internalLinks(`<a href="${baked}">Photo</a>`)).toEqual([]);
  });
});
