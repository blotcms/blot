describe("git client authenticate", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")({
    clone: false, // dont clone repo into tmp dir
  });

  var fs = require("fs-extra");
  var Git = require("simple-git");
  var http = require("http");
  var url = require("url");
  var async = require("async");
  var Blog = require("models/blog");
  var User = require("models/user");
  var dataDir = require("clients/git/dataDir");
  var createRepository = require("clients/git/create");

  var otherBlog;
  var otherUser;

  afterEach(function (done) {
    async.series(
      [
        function (next) {
          if (!otherBlog) return next();
          fs.remove(dataDir + "/" + otherBlog.handle + ".git", next);
        },
        function (next) {
          if (!otherBlog) return next();
          Blog.remove(otherBlog.id, next);
        },
        function (next) {
          if (!otherUser) return next();
          User.remove(otherUser.uid, next);
        },
      ],
      function (err) {
        otherBlog = null;
        otherUser = null;
        done(err);
      },
    );
  });

  function requestGitEndpoint(context, options, done) {
    var repos = require("clients/git/routes").repos;
    var handleSpy = spyOn(repos, "handle").and.callThrough();
    var requestOptions = {
      hostname: "127.0.0.1",
      port: context.server.port,
      path: options.path,
      method: options.method,
    };

    if (options.withCredentials) {
      requestOptions.auth = url.parse(context.repoUrl).auth;
    }

    var req = http.request(requestOptions, function (res) {
      res.resume();
      res.on("end", function () {
        expect(res.statusCode).toBe(options.status, options.path);
        if (options.handled) {
          expect(handleSpy).toHaveBeenCalled();
        } else {
          expect(handleSpy).not.toHaveBeenCalled();
        }
        done();
      });
    });

    req.on("error", done.fail);
    req.end();
  }

  it("rejects unauthenticated canonical Git endpoints before Pushover", function (done) {
    var repos = require("clients/git/routes").repos;
    var handle = this.blog.handle;
    var handleSpy = spyOn(repos, "handle").and.callThrough();
    var paths = [
      "/clients/git/end/" + handle + ".git/info/refs?service=git-upload-pack",
      "/clients/git/end/" + handle + ".git/git-receive-pack",
    ];

    function next() {
      var path = paths.shift();
      if (!path) {
        expect(handleSpy).not.toHaveBeenCalled();
        return done();
      }

      var req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.server.port,
          path: path,
        },
        function (res) {
          res.resume();
          res.on(
            "end",
            function () {
              expect(res.statusCode).toBe(401, path);
              next.call(this);
            }.bind(this),
          );
        }.bind(this),
      );

      req.on("error", done.fail);
      req.end();
    }

    next.call(this);
  });

  [
    ["rejects an unsupported method during authentication", false, 401, false],
    ["answers an authenticated unsupported method", true, 405, true],
  ].forEach(function (testCase) {
    it(testCase[0], function (done) {
      requestGitEndpoint(
        this,
        {
          path: "/clients/git/end/" + this.blog.handle + ".git/info/refs",
          method: "DELETE",
          withCredentials: testCase[1],
          status: testCase[2],
          handled: testCase[3],
        },
        done,
      );
    });
  });

  it("allows a user with good credentials to clone a repo", function (done) {
    var tmp = this.tmp;
    var handle = this.blog.handle;

    Git(tmp)
      .silent(true)
      .clone(this.repoUrl, function (err) {
        if (err) return done.fail(err);

        // Verify that there actually is a new repo on the user's file system
        expect(fs.readdirSync(tmp)).toEqual([handle]);
        expect(fs.readdirSync(tmp + "/" + handle)).toEqual([".git"]);
        done();
      });
  });

  it("prevents a user with good credentials from accessing someone else's repo", function (done) {
    var repoUrl = this.repoUrl;
    var tmp = this.tmp;

    async.waterfall(
      [
        function (next) {
          User.hashPassword("other-users-password", next);
        },
        function (passwordHash, next) {
          User.create(
            "other-git-user@example.com",
            passwordHash,
            {},
            {},
            next
          );
        },
        function (user, next) {
          otherUser = user;
          Blog.create(user.uid, { handle: "othergitrepo" }, next);
        },
        function (blog, next) {
          otherBlog = blog;
          createRepository(blog, next);
        },
        function (next) {
          repoUrl = url.parse(repoUrl);
          repoUrl.pathname = repoUrl.pathname
            .split(this.blog.handle)
            .join(otherBlog.handle);
          repoUrl = url.format(repoUrl);

          Git(tmp).silent(true).clone(repoUrl, next);
        }.bind(this),
      ],
      function (err) {
        expect(err).not.toBe(null);
        expect(err && err.message).toContain("401 Unauthorized");
        expect(fs.readdirSync(tmp)).toEqual([]);
        done();
      }
    );
  });

  it("prevents a user with invalid credentials from accessing someone else's repo", function (done) {
    var tmp = this.tmp;
    var repoUrl = this.repoUrl;

    repoUrl = url.parse(repoUrl);
    repoUrl.auth = "not_you:not_your_password";
    repoUrl = url.format(repoUrl);

    Git(tmp)
      .silent(true)
      .clone(repoUrl, function (err) {
        expect(err.message).toContain("401 Unauthorized");
        expect(fs.readdirSync(tmp)).toEqual([]);
        done();
      });
  });

  it("prevents a user with an expired token from accessing their repo", function (done) {
    var tmp = this.tmp;
    var repoUrl = this.repoUrl;

    // Now the repoUrl, which contains the token, should be invalid
    require("clients/git/database").refreshToken(
      this.blog.owner,
      function (err) {
        if (err) return done.fail(err);

        Git(tmp)
          .silent(true)
          .clone(repoUrl, function (err) {
            expect(err.message).toContain("401 Unauthorized");
            expect(fs.readdirSync(tmp)).toEqual([]);
            done();
          });
      }
    );
  });
});
