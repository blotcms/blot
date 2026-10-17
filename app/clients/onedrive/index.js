module.exports = {
  display_name: "OneDrive",
  description: "Sync your site with a folder in Microsoft OneDrive",
  disconnect: require("./disconnect"),
  resync: require("./sync/reset-to-blot"),
  getHealth: require("./getHealth"),
  remove: require("./remove"),
  write: require("./write"),
  dashboard_routes: require("./routes").dashboard,
  site_routes: require("./routes").site,
};
