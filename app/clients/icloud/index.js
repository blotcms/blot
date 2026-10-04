module.exports = {
    display_name: "iCloud",
    description: "A file storage and synchronization service",
    disconnect: require("./disconnect"),
    remove: require("./remove"),
    resync: require('./sync/fromiCloud'),
    write: require("./write"),
    site_routes: require("./routes/site"),
    dashboard_routes: require("./routes/dashboard"),
    init: require('./init')
  };
  