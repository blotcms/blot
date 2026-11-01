describe("git client handle changes", function () {
  require("./setup")({
    clone: false
  });

  var fs = require("fs-extra");
  var http = require("http");
  var host = require("config").host;
  var repo = require("clients/git/repo");
  var setBlog = require("models/blog/set");
  var getBlog = require("models/blog/get");
  var client = require("models/client");
  var key = require("models/blog/key");
  var promisify = require("util").promisify;

  function rename(blogID, handle) {
    return new Promise(function (resolve) {
      setBlog(blogID, { handle: handle, client: "git" }, function (errors) {
        resolve(errors);
      });
    });
  }

  function currentHandle(blogID) {
    return promisify(getBlog)({ id: blogID }).then(function (blog) {
      return blog.handle;
    });
  }

  it("refuses a handle with a repository left at it", async function () {
    var blog = this.blog;
    var strandedHandle = blog.handle + "stranded";
    var marker = repo.directory(strandedHandle) + "/left-behind";

    await fs.outputFile(marker, "someone else's history");

    try {
      var errors = await rename(blog.id, strandedHandle);

      expect(errors.handle.code).toBe("EEXISTS");
      expect(await currentHandle(blog.id)).toBe(blog.handle);
      expect(await fs.pathExists(repo.directory(blog.handle) + "/HEAD")).toBe(true);
      expect(await fs.pathExists(marker)).toBe(true);
    } finally {
      await fs.remove(repo.directory(strandedHandle));
    }
  });

  it("lets a blog back onto its own old handle", async function () {
    var blog = this.blog;
    var oldHandle = blog.handle;
    var newHandle = oldHandle + "renamed";

    expect(await rename(blog.id, newHandle)).toBeFalsy();

    // As if the repository had stayed behind when the blog moved
    await fs.move(repo.directory(newHandle), repo.directory(oldHandle));

    expect(await rename(blog.id, oldHandle)).toBeFalsy();
    expect(await currentHandle(blog.id)).toBe(oldHandle);
    expect(await fs.pathExists(repo.directory(oldHandle) + "/HEAD")).toBe(true);
  });

  it("rejects a move onto a repository without touching either", async function () {
    var renameRepo = require("clients/git/renameRepo");
    var oldHandle = this.blog.handle;
    var otherHandle = oldHandle + "other";
    var marker = repo.directory(otherHandle) + "/left-behind";

    await fs.outputFile(marker, "someone else's history");

    try {
      await expectAsync(renameRepo(oldHandle, otherHandle)).toBeRejected();
      expect(await fs.pathExists(repo.directory(oldHandle) + "/HEAD")).toBe(true);
      expect(await fs.pathExists(marker)).toBe(true);
    } finally {
      await fs.remove(repo.directory(otherHandle));
    }
  });

  it("keeps the handle if the repository can't move, so it can be retried", async function () {
    var blog = this.blog;
    var newHandle = blog.handle + "renamed";

    spyOn(fs, "move").and.callFake(function () {
      return Promise.reject(new Error("disk full"));
    });

    var err = await rename(blog.id, newHandle);

    expect(err.message).toContain("disk full");
    expect(await currentHandle(blog.id)).toBe(blog.handle);
    expect(await client.get(key.handle(newHandle))).toBe(null);
    expect(await fs.pathExists(repo.directory(blog.handle) + "/HEAD")).toBe(true);

    fs.move.and.callThrough();

    expect(await rename(blog.id, newHandle)).toBeFalsy();
    expect(await fs.pathExists(repo.directory(newHandle) + "/HEAD")).toBe(true);
    blog.handle = newHandle;
  });

  it("moves the repository back if the new handle can't be saved", async function () {
    var blog = this.blog;
    var newHandle = blog.handle + "renamed";
    var multi = client.multi;

    spyOn(client, "multi").and.callFake(function () {
      var transaction = multi.call(client);
      transaction.exec = function () {
        return Promise.reject(new Error("redis down"));
      };
      return transaction;
    });

    var err = await rename(blog.id, newHandle);

    client.multi.and.callThrough();

    expect(err.message).toBe("redis down");
    expect(await currentHandle(blog.id)).toBe(blog.handle);
    expect(await fs.pathExists(repo.directory(blog.handle) + "/HEAD")).toBe(true);
    expect(await fs.pathExists(repo.directory(newHandle))).toBe(false);
  });

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
