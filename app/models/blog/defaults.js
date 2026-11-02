var defaultPlugins = require("build/plugins").defaultList;
var _ = require("lodash");

module.exports = {
  client: "",
  title: "Blog",
  isDisabled: false,
  avatar: "",
  roundAvatar: false,
  imageExif: "basic",
  converters: {
    html: true,
    img: true,
    webloc: true,
    gdoc: true,
    docx: true,
    rtf: true,
    odt: true,
    org: true,
    markdown: true,
  },
  cssURL: "",
  scriptURL: "",
  template: "SITE:blog",
  menu: [
    { id: Date.now() + 1 + "", label: "Home", url: "/" },
    { id: Date.now() + 2 + "", label: "Archives", url: "/archives" },
    { id: Date.now() + 3 + "", label: "Search", url: "/search" },
    { id: Date.now() + 4 + "", label: "Feed", url: "/feed.rss" },
  ],
  domain: "",
  permalink: { format: "{{slug}}", custom: "", isCustom: false },
  timeZone: "UTC",
  status: {
    message: "Created site",
    syncID: "",
    datestamp: Date.now(),
  },
  dateFormat: "M/D/YYYY",
  forceSSL: true,
  redirectSubdomain: true,
  plugins: _.cloneDeep(defaultPlugins),
  cacheID: 0,
  flags: {
    google_drive_beta: false,
  },
};
