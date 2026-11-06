module.exports = function setup(options) {
  options = options || {};
  var database = require("clients/dropbox/database");
  var Blog = require("models/blog");
  var server = require("./server");
  var createFolder = require("./createFolder");
  var createClient = require("clients/dropbox/util/createClient");

  // Increase individual spec timeout to 60 seconds
  global.test.timeout(60 * 1000);

  global.test.blog();

  // Sets up a temporary tmp folder and cleans it up after
  global.test.tmp();

  // Set up a clean server for each test
  beforeEach(server.start);
  afterEach(server.close);

  // Allows us to check if a blog has finished syncing...
  beforeEach(function () {
    var port = this.server.port;
    var blogID = this.blog.id;

    this.afterSync = function (callback) {
      var http = require("http");
      var url = require("url").format({
        protocol: "http",
        hostname: "localhost",
        port: port,
        pathname: "/clients/dropbox/webhook/syncs-finished/" + blogID,
      });

      http.get(url, function check(res) {
        var response = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) {
          response += chunk;
        });
        res.on("end", function () {
          if (response === "true") {
            callback(null);
          } else {
            http.get(url, check);
          }
        });
      });
    };
  });

  // Expose methods for creating fake files, paths, etc.
  beforeEach(function () {
    this.fake = global.test.fake;
  });

  // Create fake dropbox account
  beforeEach(function (done) {
    var email = this.fake.internet.email();
    var blogID = this.blog.id;
    var account = {
      account_id: process.env.BLOT_DROPBOX_TEST_ACCOUNT_ID,
      access_token: process.env.BLOT_DROPBOX_TEST_ACCOUNT_APP_TOKEN,
      refresh_token: "",
      email: email,
      error_code: 0,
      last_sync: Date.now(),
      full_access: false,
      folder: "",
      folder_id: "",
      cursor: "",
    };

    this.account = account;

    Blog.set(blogID, { client: "dropbox" }, function (err) {
      if (err) return done(err);

      database.set(blogID, account, done);
    });
  });

  // Expose methods for creating fake files, paths, etc.
  beforeEach(function (done) {
    createClient(this.blog.id, (err, client) => {
      if (err) return done(err);
      this.client = client;
      done();
    });
  });

  // Create a 'blog folder' for the tests to run against. Why
  // not just use entire Dropbox folder? We hit 429 too many
  // write operation errors for some dumb reason...
  beforeEach(function (done) {
    createFolder(this.client, options, (err, folder, folderID) => {
      if (err) return done(err);

      this.folder = folder || "";
      this.folderID = folderID || "";

      database.set(this.blog.id, { folder, folderID }, done);
    });
  });

  // Remove fake account
  afterEach(function (done) {
    database.drop(this.blog.id, done);
  });

  beforeEach(function () {
    var Webhook = require("./webhook");
    var accountID = process.env.BLOT_DROPBOX_TEST_ACCOUNT_ID;
    var webhook = new Webhook(
      process.env.BLOT_DROPBOX_APP_SECRET,
      this.server.baseUrl + "/webhook"
    );

    this.webhook = function (callback) {
      webhook.notify(accountID, callback);
    };
  });

  if (options.root) beforeEach(require("./emptyFolder"));
};
