describe("git client authenticate (malformed paths with credentials)", function () {
  // Sets up a clean test blog (this.blog), sets the blog's client to git
  // (this.client), then creates a test server with the git client's routes
  // exposed, then cleans everything up when the specs have finished. Once
  // for all the specs: each one sends a single request that must be
  // rejected without touching any of it.
  require("./setup")({
    clone: false, // dont clone repo into tmp dir
    once: true,
  });

  var fs = require("fs-extra");
  var http = require("http");
  var url = require("url");

  function expectRejectedBeforePushover(
    context,
    path,
    done,
    repository,
    withCredentials,
  ) {
    var dataDir = require("clients/git/dataDir");
    var repos = require("clients/git/routes").repos;
    var handleSpy = spyOn(repos, "handle").and.callThrough();
    var requestOptions = {
      hostname: "127.0.0.1",
      port: context.server.port,
      path: path,
    };

    if (withCredentials) {
      requestOptions.auth = url.parse(context.repoUrl).auth;
    }

    var req = http.request(requestOptions, function (res) {
      res.resume();
      res.on("end", function () {
        expect(res.statusCode).toBe(404, path);
        expect(handleSpy).not.toHaveBeenCalled();
        if (repository) {
          expect(fs.existsSync(dataDir + "/" + repository + ".git")).toBe(
            false,
            path,
          );
        }
        done();
      });
    });

    req.on("error", done.fail);
    req.end();
  }

  var malformedPathCases = [
    [
      "a doubled slash after /end",
      "/clients/git/end//doubleslash.git/info/refs",
      "doubleslash",
    ],
    [
      "a doubled slash in the endpoint",
      "/clients/git/end/doubleslash.git//info/refs",
      "doubleslash",
    ],
    ["a dot segment", "/clients/git/end/./HANDLE.git/info/refs"],
    ["a traversal segment", "/clients/git/end/../HANDLE.git/info/refs"],
    ["an encoded dot segment", "/clients/git/end/%2e/HANDLE.git/info/refs"],
    [
      "an encoded traversal segment",
      "/clients/git/end/%2E%2e/HANDLE.git/info/refs",
    ],
    ["a path prefix", "/clients/git/end/prefix/HANDLE.git/info/refs", "prefix"],
    [
      "traversal inside the endpoint",
      "/clients/git/end/HANDLE.git/../info/refs",
    ],
    ["an encoded forward slash", "/clients/git/end/%2fHANDLE.git/info/refs"],
    [
      "a mixed-case encoded forward slash",
      "/clients/git/end/HANDLE.git%2Finfo/refs",
    ],
    ["a literal backslash", "/clients/git/end/HANDLE.git\\info/refs"],
    ["an encoded backslash", "/clients/git/end/HANDLE.git%5cinfo/refs"],
    [
      "a mixed-case encoded backslash",
      "/clients/git/end/HANDLE.git%5Cinfo/refs",
    ],
    ["a suffix after info/refs", "/clients/git/end/HANDLE.git/info/refs/extra"],
    [
      "a suffix after git-receive-pack",
      "/clients/git/end/HANDLE.git/git-receive-pack/extra",
    ],
    [
      "an encoded separator in the query",
      "/clients/git/end/HANDLE.git/info/refs?service=git-upload-pack%2Fextra",
    ],
    [
      "an encoded backslash in the query",
      "/clients/git/end/HANDLE.git/info/refs?service=git-upload-pack%5cextra",
    ],
  ];

  [true].forEach(function (withCredentials) {
    malformedPathCases.forEach(function (testCase) {
      it(
        "rejects " +
          testCase[0] +
          " before Pushover " +
          (withCredentials ? "with valid credentials" : "without credentials"),
        function (done) {
          expectRejectedBeforePushover(
            this,
            testCase[1].replace("HANDLE", this.blog.handle),
            done,
            testCase[2],
            withCredentials,
          );
        },
      );
    });
  });
});
