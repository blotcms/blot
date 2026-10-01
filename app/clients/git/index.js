module.exports = {
  display_name: "Git",
  description: "An open-source version control system",
  remove: require("./remove"),
  write: require("./write"),
  disconnect: require("./disconnect"),
  dashboard_routes: require("./routes").dashboard,
  site_routes: require("./routes").site,
  getHealth: require("./getHealth"),
};
