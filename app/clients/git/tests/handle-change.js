describe("git client handle changes", function () {
  require("./setup")({
    clone: false
  });

  var fs = require("fs-extra");
  var http = require("http");
  var host = require("config").host;
  var repo = require("clients/git/repo");
  var setBlog = require("models/blog/set");

  it("renames repos and redirects old handles", function (done) {
    var context = this;
    var oldHandle = context.blog.handle;
    var newHandle = oldHandle + "renamed";
    var oldRepo = repo.directory(oldHandle);
    var newRepo = repo.directory(newHandle);
    var redirectStatus = 308;

    var assertRedirect = function (path, expectedLocation, headers, callback) {
      var req = http.request(
        {
          method: "GET",
          hostname: "127.0.0.1",
          port: context.server.port,
          path,
          headers,
        },
        function (res) {
          expect(res.statusCode).toBe(redirectStatus);
          expect(res.headers.location).toBe(expectedLocation);
          res.resume();
          callback();
        }
      );

      req.on("error", function (err) {
        done.fail(err);
      });
      req.end();
    };

    fs.pathExists(oldRepo, function (err, exists) {
      if (err) return done.fail(err);
      expect(exists).toBe(true);

      setBlog(context.blog.id, { handle: newHandle, client: "git" }, function (err) {
        if (err) return done.fail(err);
        context.blog.handle = newHandle;

        fs.pathExists(newRepo, function (err, newExists) {
          if (err) return done.fail(err);
          expect(newExists).toBe(true);

          fs.pathExists(oldRepo, function (err, oldExists) {
            if (err) return done.fail(err);
            expect(oldExists).toBe(false);

            assertRedirect(
              "/clients/git/end/" + oldHandle + ".git/HEAD",
              "https://" +
                host +
                "/clients/git/end/" +
                newHandle +
                ".git/HEAD",
              {
                Host: "attacker.example",
                "X-Forwarded-Proto": "http",
              },
              function () {
                assertRedirect(
                  "/clients/git/end/" +
                    oldHandle +
                    ".git/git-upload-pack",
                  "https://" +
                    host +
                    "/clients/git/end/" +
                    newHandle +
                    ".git/git-upload-pack",
                  {},
                  function () {
                    assertRedirect(
                      "/clients/git/end/" +
                        oldHandle +
                        ".git/info/refs?service=git-receive-pack",
                      "https://" +
                        host +
                        "/clients/git/end/" +
                        newHandle +
                        ".git/info/refs?service=git-receive-pack",
                      {},
                      function () {
                        assertRedirect(
                          "/clients/git/end/" +
                            oldHandle +
                            ".git/git-receive-pack",
                          "https://" +
                            host +
                            "/clients/git/end/" +
                            newHandle +
                            ".git/git-receive-pack",
                          {},
                          done
                        );
                      }
                    );
                  }
                );
              }
            );
          });
        });
      });
    });
  });

  it(
    "publicly resolves historical handles without authentication",
    function (done) {
      var context = this;
      var oldHandle = context.blog.handle;
      var newHandle = oldHandle + "renamed";

      setBlog(
        context.blog.id,
        { handle: newHandle, client: "git" },
        function (err) {
          if (err) return done.fail(err);
          context.blog.handle = newHandle;

          var req = http.request(
            {
              method: "GET",
              hostname: "127.0.0.1",
              port: context.server.port,
              path: "/clients/git/end/" + oldHandle + ".git/HEAD",
              // Deliberately omit Authorization: handle history is public.
              headers: {},
            },
            function (res) {
              expect(res.statusCode).toBe(308);
              expect(res.headers.location).toBe(
                "https://" +
                  host +
                  "/clients/git/end/" +
                  newHandle +
                  ".git/HEAD"
              );
              res.resume();
              done();
            }
          );

          req.on("error", done.fail);
          req.end();
        }
      );
    }
  );
});
