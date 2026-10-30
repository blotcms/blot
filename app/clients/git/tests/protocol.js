// How a real git client talks to the git client's HTTP endpoint: clone,
// shallow clone, fetch, ls-remote, the protocol versions, and requests which
// git sends gzipped or chunked. Part of the regression suite for the git
// client (#2259): the endpoint is rewritten there, and a stock git client is
// the contract it has to keep.
describe("git client protocol", function () {
  // One blog with some history, which the specs add to but do not rewrite
  require("./setup")({ clone: false, client: true, once: true });

  var crypto = require("crypto");
  var Client = require("./setup/client");
  var helpers = require("./setup/helpers");

  beforeAll(async function () {
    await this.local.commitFiles({ "/protocol/one.txt": "One" });
    await this.local.commitFiles({ "/protocol/two.txt": "Two", "/protocol/nested/three.txt": "Three" });
    await this.local.push();
  });

  afterEach(async function () {
    await this.local.expectSynced();
  });

  // Makes a number of (empty) commits one after the other
  async function commitMany(client, prefix, total) {
    for (var i = 0; i < total; i++) {
      await client.commit(prefix + " " + i, { allowEmpty: true });
    }
  }

  it("clones", async function () {
    var clone = await this.local.cloneAgain();

    expect(await clone.head()).toBe(await this.local.remoteHead());
    await Client.compareDirectories(clone.directory, this.blogDirectory);
  });

  it("clones with --depth 1", async function () {
    var clone = await this.local.cloneAgain({ args: ["--depth", "1"] });

    expect((await clone.git(["rev-parse", "--is-shallow-repository"])).stdout.trim()).toBe("true");
    expect((await clone.git(["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    expect(await clone.head()).toBe(await this.local.remoteHead());
    await Client.compareDirectories(clone.directory, this.blogDirectory);
  });

  it("clones with a blob filter, whether or not the server supports it", async function () {
    var clone = await this.local.cloneAgain({ args: ["--filter=blob:none"] });

    expect(await clone.head()).toBe(await this.local.remoteHead());
    await Client.compareDirectories(clone.directory, this.blogDirectory);
  });

  it("fetches only what is new", async function () {
    var clone = await this.local.cloneAgain();

    await this.local.writeAndPush("/protocol/fetched.txt", "Pushed after the clone");

    var fetched = await clone.git(["fetch", "origin"]);

    expect(fetched.code).toBe(0);
    expect((await clone.git(["rev-parse", "origin/master"])).stdout.trim()).toBe(
      await this.local.remoteHead()
    );

    await clone.git(["merge", "--ff-only", "origin/master"]);
    await Client.compareDirectories(clone.directory, this.blogDirectory);
  });

  it("lists refs with ls-remote", async function () {
    var output = (await this.local.git(["ls-remote", "origin"])).stdout;
    var head = await this.local.remoteHead();
    var lines = output.trim().split("\n");

    expect(lines).toContain(head + "\trefs/heads/master");
    expect(lines).toContain(head + "\tHEAD");
  });

  [0, 1, 2].forEach(function (version) {
    it("clones and pushes with protocol version " + version, async function () {
      var clone = await this.local.cloneAgain({ config: { "protocol.version": String(version) } });

      expect(await clone.head()).toBe(await this.local.remoteHead());

      await clone.writeAndPush("/protocol/version-" + version + ".txt", "Pushed with version " + version);

      expect(await helpers.blogHas(this, "/protocol/version-" + version + ".txt")).toBe(true);
      expect((await clone.git(["ls-remote", "origin", "refs/heads/master"])).stdout).toContain(
        await clone.head()
      );

      // The first clone pulls what the other pushed
      await this.local.pull();
      await this.local.expectSynced();
    });
  });

  it("negotiates a fetch large enough for git to gzip its request", async function () {
    var proxy = await Client.startRecordingProxy(this.server.port);

    try {
      var other = await this.local.cloneAgain({ url: proxy.rewrite(this.local.url) });

      // Many commits on each side which the other does not have, so that the
      // client lists far more than a kilobyte of commits it has
      await commitMany(other, "ours", 120);
      await commitMany(this.local, "theirs", 120);
      await this.local.push();

      var fetched = await other.git(["fetch", "origin"]);

      expect(fetched.code).toBe(0);
      expect((await other.git(["rev-parse", "origin/master"])).stdout.trim()).toBe(
        await this.local.remoteHead()
      );

      // The request was in fact compressed
      var gzipped = proxy.requests.filter(function (request) {
        return (
          request.method === "POST" &&
          /git-upload-pack$/.test(request.url) &&
          request.headers["content-encoding"] === "gzip"
        );
      });

      expect(gzipped.length).toBeGreaterThan(0);
    } finally {
      await proxy.close();
    }
  });

  it("pushes more than http.postBuffer, which git sends chunked", async function () {
    var proxy = await Client.startRecordingProxy(this.server.port);

    try {
      var other = await this.local.cloneAgain({ url: proxy.rewrite(this.local.url) });

      // Only for the push: with the setting a clone itself would need a
      // probe request which is not what this spec is about
      other.config = { "http.postBuffer": "65536" };

      // Random bytes do not compress, so the push is as big as the file
      var big = crypto.randomBytes(512 * 1024);

      await other.write("/protocol/big.bin", big);
      await other.commit("Add a big file");
      await other.push();

      expect(await helpers.blogFile(this, "/protocol/big.bin")).toEqual(big);

      var chunked = proxy.requests.filter(function (request) {
        return (
          request.method === "POST" &&
          /git-receive-pack$/.test(request.url) &&
          request.headers["transfer-encoding"] === "chunked"
        );
      });

      expect(chunked.length).toBeGreaterThan(0);

      await this.local.pull();
    } finally {
      await proxy.close();
    }
  });
});
