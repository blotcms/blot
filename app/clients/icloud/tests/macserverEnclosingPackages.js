// brctl can't download a file inside a package (iCloud keeps the package as
// one item), so brctl/download.js downloads the package around it. Only the
// choice of folders runs here: brctl itself needs macOS.
const path = require("path");
const { pathToFileURL } = require("url");

describe("icloud macserver enclosingPackages", function () {
  let enclosingPackages;

  beforeAll(async function () {
    ({ default: enclosingPackages } = await import(
      pathToFileURL(
        path.join(__dirname, "../macserver/brctl/enclosingPackages.js")
      ).href
    ));
  });

  it("finds the package a file is in", function () {
    expect(
      enclosingPackages("blog_a/eps/eps.bbprojectd/Scratchpad.txt")
    ).toEqual(["blog_a/eps/eps.bbprojectd"]);
  });

  it("lists nested packages nearest first", function () {
    expect(
      enclosingPackages("blog_a/Site/Book.pages/Data/inner.bundle/x.png")
    ).toEqual([
      "blog_a/Site/Book.pages/Data/inner.bundle",
      "blog_a/Site/Book.pages",
    ]);
  });

  it("never offers an ordinary folder or the blog's own folder", function () {
    expect(enclosingPackages("blog_a/My.Site/Posts/post.md")).toEqual([]);
    expect(enclosingPackages("blog_a/Site/post.md")).toEqual([]);
    expect(enclosingPackages("blog_a/Site/.hidden/post.md")).toEqual([]);
  });
});
