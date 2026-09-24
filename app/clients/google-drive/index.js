module.exports = {
  display_name: "Google Drive",
  description: "A file storage and synchronization service",
  disconnect: require("./disconnect"),
  resync: require('./sync/resetFromDrive'),
  remove: require("./remove"),
  write: require("./write"),
  site_routes: require("./routes/site"),
  dashboard_routes: require("./routes/dashboard"),
  init: require('./init')
};
