module.exports = {
  display_name: "Dropbox",
  description:
    "A file storage and synchronization service",
  init: require("./init"),
  disconnect: require("./disconnect"),
  resync: require('./sync/reset-to-blot'),
  remove: require("./remove"),
  write: require("./write"),
  site_routes: require("./routes").site,
  dashboard_routes: require("./routes").dashboard,
};
