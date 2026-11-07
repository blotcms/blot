// A handle change moves nothing: the repository is keyed by blog ID. What is
// left to check is that a remote with the old handle is told the new one.
describe("git client handle changes", function () {
  require("./setup")({
    clone: false,
  });

  var http = require("http");
  var host = require("config").host;
  var setBlog = require("models/blog/set");

  function rename(blogID, handle) {
    return setBlog(blogID, { handle: handle, client: "git" });
  }

  // Resolves with the response's status and Location
  function request(port, path, headers) {
    return new Promise(function (resolve, reject) {
      var req = http.request(
        {
          method: "GET",
          hostname: "127.0.0.1",
          port: port,
          path: path,
          headers: headers || {},
        },
        function (res) {
          res.resume();
          resolve({ status: res.statusCode, location: res.headers.location });
        }
      );

      req.on("error", reject);
      req.end();
    });
  }

  it("redirects old handles to the new one", async function () {
    var oldHandle = this.blog.handle;
    var newHandle = oldHandle + "renamed";

    await rename(this.blog.id, newHandle);
    this.blog.handle = newHandle;

    var paths = [
      [".git/HEAD", { Host: "attacker.example", "X-Forwarded-Proto": "http" }],
      [".git/git-upload-pack"],
      [".git/info/refs?service=git-receive-pack"],
      [".git/git-receive-pack"],
    ];

    for (var [path, headers] of paths) {
      var res = await request(
        this.server.port,
        "/clients/git/end/" + oldHandle + path,
        headers
      );

      expect(res.status).toBe(308);
      expect(res.location).toBe(
        "https://" + host + "/clients/git/end/" + newHandle + path
      );
    }
  });

  it("publicly resolves historical handles without authentication", async function () {
    var oldHandle = this.blog.handle;
    var newHandle = oldHandle + "renamed";

    await rename(this.blog.id, newHandle);
    this.blog.handle = newHandle;

    // Deliberately no Authorization: handle history is public
    var res = await request(
      this.server.port,
      "/clients/git/end/" + oldHandle + ".git/HEAD"
    );

    expect(res.status).toBe(308);
    expect(res.location).toBe(
      "https://" + host + "/clients/git/end/" + newHandle + ".git/HEAD"
    );
  });
});
