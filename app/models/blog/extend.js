var PUBLIC = require("./scheme").PUBLIC;
var config = require("config");
var protocol = "https";
var punycode = require("helper/punycode");
var imageExif = require("./util/imageExif");
var converters = require("./util/converters");
var normalized = require("./util/normalized");

module.exports = function extend(blog) {
  var pages = [];

  // External links have a timestamp
  // as their ID, pages have their entry ID
  for (var a in blog.menu)
    if (blog.menu[a].id.length < 10) pages.push(blog.menu[a]);

  // is it bad to extend the blog object here?
  blog.pretty = {};

  // Blog.get has already done this for its blogs
  if (!normalized.has(blog)) {
    imageExif.apply(blog);
    converters.apply(blog);
  }

  if (blog.dateFormat) blog["is" + blog.dateFormat] = "selected";

  // this is a hack and should be
  if (blog.menu && blog.menu.length) {
    for (var i in blog.menu) {
      // External links have a timestamp
      // as their ID, pages have their entry ID
      if (blog.menu[i].id[0] === "/") {
        blog.menu[i].isPage = true;
      }
    }

    blog.menu[blog.menu.length - 1].last = true;
  }

  // pages are used by the sitemap.
  blog.pages = pages;
  blog.showPages = pages.length > 0;
  blog.totalPages = pages.length;

  blog.feedURL = "/feed.rss";
  blog.url = protocol + "://" + blog.handle + "." + config.host;

  blog.previewURL = `https://preview-of-${blog.handle}.${config.host}`;
  blog.pretty.url = blog.handle + "." + config.host;
  blog.pretty.label = blog.title || blog.pretty.url;

  if (blog.domain) {
    blog.url = protocol + "://" + blog.domain;
    blog.pretty.url = punycode.toUnicode(blog.domain);
    blog.pretty.domain = punycode.toUnicode(blog.domain);
  }

  blog.blogURL = protocol + "://" + blog.handle + "." + config.host;

  // Exposed to templates..
  blog.locals = {
    feedURL: blog.feedURL,
    blogURL: blog.blogURL,
    siteURL: blog.blogURL,
  };

  blog.locals.imageExif = blog.imageExif;
  blog.locals.imageExifMode = blog.imageExifMode;
  blog.locals.isImageExifOff = blog.isImageExifOff;
  blog.locals.isImageExifBasic = blog.isImageExifBasic;
  blog.locals.isImageExifFull = blog.isImageExifFull;

  blog.locals.converters = blog.converters;

  // Import blog info into
  // rendering context
  for (var x in blog) if (PUBLIC.indexOf(x) > -1) blog.locals[x] = blog[x];

  return blog;
};
