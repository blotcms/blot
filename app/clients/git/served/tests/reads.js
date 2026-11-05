describe("git store: reads", function () {
  // A blog on the git client with a clone, a memory store per blog, and the
  // store's log lines kept
  require("clients/git/tests/setup")({ clone: false, client: true, lines: true });

  var Client = require("clients/git/tests/setup/client");
  var http = require("http");
  var path = require("path");

  function lines(ctx, pattern) {
    return ctx.storeLines().filter(function (line) {
      return pattern.test(line);
    });
  }

  async function lineMatching(ctx, pattern) {
    for (var i = 0; i < 100; i++) {
      var found = lines(ctx, pattern);
      if (found.length) return found;
      await new Promise(function (resolve) {
        setTimeout(resolve, 20);
      });
    }

    throw new Error("No log line matched " + pattern);
  }

  function request(ctx, method, suffix, options) {
    options = options || {};

    var parsed = new URL(ctx.repoUrl);
    var user = decodeURIComponent(parsed.username);
    var token = options.auth === "wrong" ? "wrong" : decodeURIComponent(parsed.password);
    var headers = Object.assign({}, options.headers);

    if (options.auth !== "none") headers.Authorization = "Basic " + Buffer.from(user + ":" + token).toString("base64");

    return new Promise(function (resolve, reject) {
      var req = http.request(
        {
          method: method,
          hostname: "127.0.0.1",
          port: ctx.server.port,
          path: "/clients/git/end/" + ctx.blog.handle + ".git" + suffix,
          headers: headers,
        },
        function (res) {
          var chunks = [];
          res.on("data", function (chunk) {
            chunks.push(chunk);
          });
          res.on("end", function () {
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("latin1") });
          });
        }
      );

      req.on("error", reject);
      req.end(options.body);
    });
  }

  function directory(ctx, name) {
    return path.join(ctx.tmp, name);
  }

  function pktLine(text) {
    return ("0000" + (Buffer.byteLength(text) + 4).toString(16)).slice(-4) + text;
  }

  // Leaves the blog with an empty store
  function emptyStore(ctx) {
    ctx.stores[ctx.blog.id] = require("clients/git/store").createMemoryStore();
    require("clients/git/served/context")._reset();
  }

  it("serves the advertisements, clones and fetches from the store", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await this.local.git(["tag", "light"]);
    await this.local.git(["tag", "-a", "annotated", "-m", "An annotated tag"]);
    await this.local.push(["origin", "--tags"]);

    var head = await this.local.head();
    var light = (await this.local.git(["rev-parse", "light"])).stdout.trim();
    var annotated = (await this.local.git(["rev-parse", "annotated"])).stdout.trim();

    var advertised = (await this.local.git(["ls-remote", this.repoUrl])).stdout;
    expect(advertised).toBe(
      [head + "\tHEAD", head + "\trefs/heads/master", annotated + "\trefs/tags/annotated", head + "\trefs/tags/annotated^{}", light + "\trefs/tags/light", ""].join("\n")
    );

    // The receive-pack advertisement: sorted refs, the capabilities on the
    // first, no HEAD and no peeled tags
    var receiving = await request(this, "GET", "/info/refs?service=git-receive-pack");
    expect(receiving.status).toBe(200);
    expect(receiving.headers["content-type"]).toBe("application/x-git-receive-pack-advertisement");
    expect(receiving.body).toBe(
      pktLine("# service=git-receive-pack\n") +
        "0000" +
        pktLine(head + " refs/heads/master\0report-status delete-refs side-band-64k quiet ofs-delta agent=blot\n") +
        pktLine(annotated + " refs/tags/annotated\n") +
        pktLine(light + " refs/tags/light\n") +
        "0000"
    );

    var clone = await Client.clone({ url: this.repoUrl, directory: directory(this, "clone") });

    expect(await clone.head()).toBe(head);
    expect((await clone.try(["fsck", "--strict"])).code).toBe(0);
    expect(await clone.tree()).toEqual(await this.local.tree());

    await this.local.writeAndPush("/b.txt", "B");

    await clone.git(["-c", "transfer.fsckObjects=true", "fetch", "origin"]);
    expect((await clone.git(["rev-parse", "origin/master"])).stdout.trim()).toBe(await this.local.head());
    expect((await clone.try(["fsck", "--strict"])).code).toBe(0);

    var id = this.blog.id;

    expect((await lineMatching(this, / op=advertise /))[0]).toMatch(
      new RegExp("blog=" + id + " op=advertise outcome=ok ms=\\d+ firstByteMs=\\d+ requests=\\d+ bytesDown=\\d+ bytesSent=\\d+$")
    );
    expect((await lineMatching(this, / op=receive-advertise outcome=ok /)).length).toBeGreaterThan(0);
    expect((await lineMatching(this, / op=clone outcome=ok /)).length).toBeGreaterThan(0);
    expect((await lineMatching(this, / op=fetch outcome=ok /)).length).toBeGreaterThan(0);

    // IDs only
    var handle = this.blog.handle;
    this.storeLines().forEach(function (line) {
      expect(line).not.toContain(handle);
    });
  });

  it("answers a warm advertisement with one request to the store", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    // The first reads the hint the push wrote, with the HEAD beside it
    // (unless the sync after the push read it first); the second, within a
    // few seconds, is the hint's GET alone, answered 304
    for (var i = 0; i < 2; i++) {
      expect((await request(this, "GET", "/info/refs?service=git-upload-pack")).status).toBe(200);
    }

    var ctx = this;
    var advertised = [];
    for (var tries = 0; tries < 100 && advertised.length < 2; tries++) {
      advertised = lines(ctx, / op=advertise outcome=ok /);
      await new Promise(function (resolve) {
        setTimeout(resolve, 20);
      });
    }

    expect(advertised.length).toBe(2);
    expect(advertised[0]).toMatch(/ requests=[12] /);
    expect(advertised[1]).toMatch(/ requests=1 bytesDown=0 /);
  });

  it("answers the HEAD probe from the manifest", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var served = await request(this, "GET", "/HEAD");

    expect(served.status).toBe(200);
    expect(served.body).toBe("ref: refs/heads/master\n");
  });

  it("refuses a shallow clone with a remote error", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var shallow = await Client.clone({ url: this.repoUrl, directory: directory(this, "shallow"), args: ["--depth", "1"] }).then(
      function () {
        return null;
      },
      function (err) {
        return err;
      }
    );

    expect(shallow).not.toBe(null);
    // The advertisement offers no shallow, so git refuses before asking; a
    // client which asks anyway is sent an ERR packet ("remote error")
    expect(shallow.stderr).toMatch(/does not support shallow|remote error/);
  });

  it("logs why it refused a clone: shallow, filter or other", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    var head = await this.local.head();
    var want = pktLine("want " + head + " ofs-delta side-band-64k\n");
    var cases = [
      ["shallow", want + pktLine("deepen 1\n") + "0000" + pktLine("done\n")],
      ["shallow", want + pktLine("deepen-since 1700000000\n") + "0000" + pktLine("done\n")],
      ["filter", want + pktLine("filter blob:none\n") + "0000" + pktLine("done\n")],
      ["other", pktLine("want " + "1".repeat(40) + " ofs-delta\n") + "0000" + pktLine("done\n")],
    ];

    for (var [reason, body] of cases) {
      var before = this.storeLines().length;
      var response = await request(this, "POST", "/git-upload-pack", {
        body: body,
        headers: { "Content-Type": "application/x-git-upload-pack-request" },
      });

      expect(response.body).toContain("ERR ");

      var line = undefined;
      for (var i = 0; i < 100 && !line; i++) {
        line = this.storeLines().slice(before).find((l) => / outcome=refused /.test(l));
        if (!line) await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(line).toMatch(new RegExp(" outcome=refused .*reason=" + reason + "( |$)"));
    }
  });

  it("tells a shallow request from a filter and anything else", function () {
    var { refusalReason } = require("clients/git/served/reads");
    var want = pktLine("want " + "a".repeat(40) + "\n");

    expect(refusalReason(Buffer.from(want + pktLine("shallow " + "b".repeat(40) + "\n") + "0000"))).toBe("shallow");
    expect(refusalReason(Buffer.from(want + pktLine("deepen-not refs/heads/x\n") + "0000"))).toBe("shallow");
    expect(refusalReason(Buffer.from(want + pktLine("filter tree:0\n") + pktLine("deepen 2\n") + "0000"))).toBe("shallow");
    expect(refusalReason(Buffer.from(want + pktLine("filter tree:0\n") + "0000"))).toBe("filter");
    expect(refusalReason(Buffer.from(want + "0000"))).toBe("other");
    expect(refusalReason(Buffer.from("not git"))).toBe("other");
  });

  it("says so when the store has no copy, and never serves an empty repository", async function () {
    emptyStore(this);

    var advertised = await request(this, "GET", "/info/refs?service=git-upload-pack");
    expect(advertised.status).toBe(503);
    expect(advertised.body).toContain("no copy");

    var receiving = await request(this, "GET", "/info/refs?service=git-receive-pack");
    expect(receiving.status).toBe(503);

    var clone = await Client.clone({ url: this.repoUrl, directory: directory(this, "nothing") }).then(
      function () {
        return null;
      },
      function (err) {
        return err;
      }
    );
    expect(clone).not.toBe(null);
  });

  it("refuses bad authentication", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    for (var auth of ["wrong", "none"]) {
      var response = await request(this, "GET", "/info/refs?service=git-upload-pack", { auth: auth });
      expect(response.status).toBe(401);

      var post = await request(this, "POST", "/git-upload-pack", { auth: auth, body: "0000" });
      expect(post.status).toBe(401);
    }
  });

  it("answers what is not a git request with the statuses Blot's git server has always given", async function () {
    await this.local.writeAndPush("/a.txt", "A");

    expect((await request(this, "GET", "/info/refs")).status).toBe(400);
    expect((await request(this, "GET", "/info/refs?service=git-other")).status).toBe(405);
    // Not a git route at all (routes.js)
    expect((await request(this, "POST", "/git-other-pack")).status).toBe(404);
    expect((await request(this, "PUT", "/info/refs?service=git-upload-pack")).status).toBe(405);
  });
});
