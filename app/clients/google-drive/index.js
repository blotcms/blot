module.exports = {
  display_name: "Google Drive",
  description: "A file storage and synchronization service",
  disconnect: require("./disconnect"),
  remove: require("./remove"),
  write: require("./write"),
  getHealth: require("./getHealth"),
  site_routes: require("./routes/site"),
  dashboard_routes: require("./routes/dashboard"),
  init: require('./init')
};
