describe("git client authenticate", function () {
  // Sets up a clean test blog (this.blog) for each test,
  // sets the blog's client to git (this.client), then creates
  // a test server with the git client's routes exposed, then
  // cleans everything up when each test has finished.
  require("./setup")({
    clone: false, // dont clone repo into tmp dir
  });

  var fs = require("fs-extra");
  var Git = require("./setup/git");
  var http = require("http");
  var url = require("url");
  var Blog = require("models/blog");
  var User = require("models/user");
  var createRepository = require("clients/git/create");

  var otherBlog;
  var otherUser;

  afterEach(async function () {
    try {
      if (otherBlog) await Blog.remove(otherBlog.id);
      if (otherUser) await User.remove(otherUser.uid);
    } finally {
      otherBlog = null;
      otherUser = null;
    }
  });

  function requestGitEndpoint(context, options, done) {
    var repo = require("clients/git/repo");
    var handleSpy = spyOn(repo, "handleSmartHttp").and.callThrough();
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
    var repo = require("clients/git/repo");
    var handle = this.blog.handle;
    var handleSpy = spyOn(repo, "handleSmartHttp").and.callThrough();
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
            }.bind(this)
          );
        }.bind(this)
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
        done
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

  it("prevents a user with good credentials from accessing someone else's repo", async function () {
    var repoUrl = this.repoUrl;
    var tmp = this.tmp;

    var passwordHash = await User.hashPassword("other-users-password");
    otherUser = await User.create(
      "other-git-user@example.com",
      passwordHash,
      {},
      {}
    );
    otherBlog = await Blog.create(otherUser.uid, { handle: "othergitrepo" });
    await createRepository(otherBlog);

    repoUrl = url.parse(repoUrl);
    repoUrl.pathname = repoUrl.pathname
      .split(this.blog.handle)
      .join(otherBlog.handle);
    repoUrl = url.format(repoUrl);

    var err = await new Promise(function (resolve) {
      Git(tmp).silent(true).clone(repoUrl, resolve);
    });

    expect(err).not.toBe(null);
    expect(err && err.message).toContain("401 Unauthorized");
    expect(fs.readdirSync(tmp)).toEqual([]);
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

  it("prevents a user with an expired token from accessing their repo", async function () {
    var tmp = this.tmp;
    var repoUrl = this.repoUrl;

    // Now the repoUrl, which contains the token, should be invalid
    await require("clients/git/database").refreshToken(this.blog.owner);

    var err = await new Promise(function (resolve) {
      Git(tmp).silent(true).clone(repoUrl, resolve);
    });

    expect(err.message).toContain("401 Unauthorized");
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
