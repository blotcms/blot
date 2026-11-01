describe("git client branches", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")();

  var fs = require("fs-extra");
  var http = require("http");
  var url = require("url");

  function waitForSync(ctx, done) {
    var syncUrl = url.format({
      protocol: "http",
      hostname: "127.0.0.1",
      port: ctx.server.port,
      pathname: "/clients/git/syncs-finished/" + ctx.blog.id,
    });

    http.get(syncUrl, function check(res) {
      var response = "";
      res.setEncoding("utf8");
      res.on("data", function (chunk) {
        response += chunk;
      });
      res.on("end", function () {
        if (response !== "true") {
          return http.get(syncUrl, check);
        }
        done();
      });
    });
  }

  it("accepts pushes to master", function (done) {
    var ctx = this;
    var path = ctx.fake.path(".txt");
    var content = ctx.fake.file();

    fs.outputFile(ctx.repoDirectory + path, content, function (err) {
      if (err) return done.fail(err);

      ctx.git.add(".", function (err) {
        if (err) return done.fail(err);

        ctx.git.commit("add file", function (err) {
          if (err) return done.fail(err);

          ctx.git.push(function (err) {
            if (err) return done.fail(err);

            waitForSync(ctx, function () {
              fs.pathExists(ctx.blogDirectory + path, function (err, exists) {
                if (err) return done.fail(err);
                expect(exists).toEqual(true);
                done();
              });
            });
          });
        });
      });
    });
  });

  it("rejects pushes to non-master branches", function (done) {
    var ctx = this;
    var branch = "feature/branch-check";
    var path = ctx.fake.path(".txt");
    var content = ctx.fake.file();

    ctx.git.checkoutLocalBranch(branch, function (err) {
      if (err) return done.fail(err);

      fs.outputFile(ctx.repoDirectory + path, content, function (err) {
        if (err) return done.fail(err);

        ctx.git.add(".", function (err) {
          if (err) return done.fail(err);

          ctx.git.commit("add file on branch", function (err) {
            if (err) return done.fail(err);

            ctx.git.push("origin", branch, function (err) {
              expect(err).not.toBeNull();
              expect(String(err)).toContain("only the master branch is allowed");

              fs.pathExists(ctx.blogDirectory + path, function (err, exists) {
                if (err) return done.fail(err);
                expect(exists).toEqual(false);
                done();
              });
            });
          });
        });
      });
    });
  });
});
