module.exports = {
  display_name: "GitHub",
  description: "Sync your site with a repository on GitHub",
  disconnect: require("./disconnect"),
  remove: require("./remove"),
  write: require("./write"),
  dashboard_routes: require("./routes").dashboard,
  site_routes: require("./routes").site,
};
