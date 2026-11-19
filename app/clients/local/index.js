module.exports = {
  // The display name and description are shown
  // on the client page of the dashboard
  display_name: "Local",
  description: "Edit your blog folder directly",

  // Write and remove are invoked by Blot and
  // instruct the client to write or remove a
  // file to the user's blog folder. This happens
  // when Blot needs to write a preview file, or
  // the files required to edit a template.
  write: require("./write"),
  remove: require("./remove"),

  // Disconnect is invoked when the user switches
  // to a different client or deletes his account.
  disconnect: require("./disconnect"),

  // This is where the user is asked to select a folder
  dashboard_routes: require("./routes"),

  // This is invoked by the master process and will
  // watch the blog folder for any changes
  init: require("./init"),

  // We expose a special method to make it easier
  // for the test suite and script to build the
  // demonstration blogs to interact with this client.
  // No need to expose this for a conventional client.
  setup: require("./setup"),
};
