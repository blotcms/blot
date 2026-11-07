describe("transformer", function () {
  var folder = require("storage/folder");
  var Keys = require("../keys");
  var client = require("models/client");
  var blogKey = require("models/blog/key");
  var Transformer = require("../index");
  var assets = require("storage/assets");

  // Creates test environment
  require("./setup")({});

  // Resolves with the error a promise rejects with
  async function failure(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }

    throw new Error("Expected the promise to reject");
  }

  it("transforms a file in the blog's directory", async function () {
    const result = await this.transformer.lookup(this.path, this.transform);

    expect(result).toEqual(jasmine.any(Object));
    expect(result.size).toEqual(jasmine.any(Number));
  });

  it("transforms a file with incorrect case in the blog's directory", async function () {
    this.path = this.path.toUpperCase();

    const result = await this.transformer.lookup(this.path, this.transform);

    expect(result).toEqual(jasmine.any(Object));
    expect(result.size).toEqual(jasmine.any(Number));
  });

  it("transforms a file with windows-style slashes and incorrect case in the blog's directory", async function () {
    var from = "/" + this.path;
    this.path = "/Hello/new world.txt";

    await folder.move(this.blog.id, from, this.path);

    const result = await this.transformer.lookup(
      "Hello\\new%20World.txt",
      this.transform
    );

    expect(result).toEqual(jasmine.any(Object));
    expect(result.size).toEqual(jasmine.any(Number));
  });

  it("transforms a file whose path has been URI encoded", async function () {
    var from = "/" + this.path;
    this.path = "/Hello world.txt";

    await folder.move(this.blog.id, from, this.path);

    this.path = encodeURI(this.path);

    const result = await this.transformer.lookup(this.path, this.transform);

    expect(result).toEqual(jasmine.any(Object));
    expect(result.size).toEqual(jasmine.any(Number));
  });

  it("transforms a file whose path with incorrect case contains an accent and URI encoded characters", async function () {
    var from = "/" + this.path;
    this.path = "/Hållœ wòrld.txt";

    await folder.move(this.blog.id, from, this.path);

    this.path = encodeURI(this.path);

    const result = await this.transformer.lookup(
      this.path.toLowerCase(),
      this.transform
    );

    expect(result).toEqual(jasmine.any(Object));
    expect(result.size).toEqual(jasmine.any(Number));
  });

  it("will not transform a file that does not exist", async function () {
    var spy = jasmine.createSpy().and.callFake(this.transform);

    await folder.remove(this.blog.id, "/" + this.path);

    const err = await failure(this.transformer.lookup(this.path, spy));

    expect(err instanceof Error).toBe(true);
    expect(err.code).toEqual("ENOENT");
    expect(spy).not.toHaveBeenCalled();
  });

  it("will not resolve a source that climbs out of the blog's static folder", async function () {
    var spy = jasmine.createSpy().and.callFake(this.transform);

    // An asset that exists for another blog but NOT in this blog's scope.
    var otherBlogID = "blog_other" + this.blog.id.slice(5);
    var secretName = "_assets/secret-" + Date.now() + ".txt";

    await assets.write(otherBlogID, secretName, "top secret");

    try {
      const err = await failure(
        this.transformer.lookup("../" + otherBlogID + "/" + secretName, spy)
      );

      expect(err instanceof Error).toBe(true);
      expect(err.code).toEqual("ENOENT");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await assets.removeAll(otherBlogID);
    }
  });

  it("transforms a file in the blog's static directory", async function () {
    // Generated assets live in the blog's underscore directories
    var path = "/_image_cache/" + Date.now() + "-" + this.path;

    await assets.write(
      this.blog.id,
      path,
      await folder.read(this.blog.id, "/" + this.path)
    );

    const result = await this.transformer.lookup(path, this.transform);

    expect(result).toEqual(jasmine.any(Object));
    expect(result.size).toEqual(jasmine.any(Number));
  });

  it("transforms a file in the blog's static directory linked with an escaped name", async function () {
    var path = "/_image_cache/" + Date.now() + "/说明.png";

    await assets.write(
      this.blog.id,
      path,
      await folder.read(this.blog.id, "/" + this.path)
    );

    const result = await this.transformer.lookup(
      "/_image_cache/" +
        path.split("/")[2] +
        "/" +
        encodeURIComponent("说明.png"),
      this.transform
    );

    expect(result).toEqual(jasmine.any(Object));
    expect(result.size).toEqual(jasmine.any(Number));
  });

  it("transforms the same file once", async function () {
    var firstTransform = jasmine.createSpy().and.callFake(this.transform);
    var secondTransform = jasmine.createSpy().and.callFake(this.transform);

    const firstResult = await this.transformer.lookup(
      this.path,
      firstTransform
    );
    const secondResult = await this.transformer.lookup(
      this.path,
      secondTransform
    );

    expect(firstTransform).toHaveBeenCalled();
    expect(secondTransform).not.toHaveBeenCalled();
    expect(firstResult).toEqual(secondResult);
  });

  it("re-transforms the file if its contents changes", async function () {
    var spy = jasmine.createSpy().and.callFake(this.transform);

    const firstResult = await this.transformer.lookup(
      this.path,
      this.transform
    );

    // Modify the file
    await folder.write(this.blog.id, "/" + this.path, Date.now().toString());

    const secondResult = await this.transformer.lookup(this.path, spy);

    expect(spy).toHaveBeenCalled();
    expect(firstResult).not.toEqual(secondResult);
  });

  it("transforms a url", async function () {
    const result = await this.transformer.lookup(this.url, this.transform);

    expect(result).toEqual(jasmine.any(Object));
    expect(result.size).toEqual(jasmine.any(Number));
  });

  describe("own-host resolution", function () {
    beforeEach(async function () {
      this.ownHostTransformer = new Transformer(this.blog.id, "own-host");

      // Point this blog's "domain" at "localhost", in Redis, the way a
      // real blog's custom domain is stored - the transformer looks
      // this up itself rather than being told. Deliberately portless:
      // ownHost.resolve() now rejects any URL with an explicit port
      // (a real custom domain never has one), and the shared test
      // server only listens on a non-default port, so a URL that could
      // actually reach it could never be treated as this blog's own
      // domain anyway - see the two tests below.
      await client.hSet(blogKey.info(this.blog.id), "domain", "localhost");
    });

    afterEach(async function () {
      await this.ownHostTransformer.flush();
    });

    it("resolves a URL on the blog's own host from disk instead of fetching it", async function () {
      var spy = jasmine.createSpy().and.callFake(this.transform);
      var ownURL = "http://localhost/" + this.path;

      const result = await this.ownHostTransformer.lookup(ownURL, spy);

      expect(spy).toHaveBeenCalled();
      // Nothing listens on localhost:80 in this test environment, so
      // this could only have succeeded by resolving "foo.txt" from
      // the blog's own folder, never by going over the network.
      expect(result).toEqual(jasmine.any(Object));
      expect(result.size).toEqual(jasmine.any(Number));
    });

    it("falls back to a network fetch when the local file doesn't exist", async function () {
      // Nothing listens on localhost:80, so this proves the own-host
      // branch tried local resolution first (which fails, no such
      // file), then fell back into the normal network path - it fails
      // for a different reason (connection refused) than a bare local
      // lookup would (ENOENT).
      var missingURL =
        "http://localhost/this-file-does-not-exist-" + Date.now();

      const err = await failure(
        this.ownHostTransformer.lookup(missingURL, this.transform)
      );

      expect(err).toEqual(jasmine.any(Error));
      expect(err.code).not.toEqual("ENOENT");
    });
  });

  it("uses cached transform when the url responds with 304", async function () {
    var firstTransform = jasmine.createSpy().and.callFake(this.transform);
    var secondTransform = jasmine.createSpy().and.callFake(this.transform);

    const firstResult = await this.transformer.lookup(this.url, firstTransform);
    const secondResult = await this.transformer.lookup(
      this.url,
      secondTransform
    );

    expect(firstTransform).toHaveBeenCalled();
    expect(secondTransform).not.toHaveBeenCalled();
    expect(secondResult).toEqual(firstResult);
  });

  it("reuses cached headers when the stored response is still fresh", async function () {
    var keys = Keys(this.blog.id, "transformer");
    var headersKey = keys.url.headers(this.url);
    var firstTransform = jasmine.createSpy().and.callFake(this.transform);
    var secondTransform = jasmine.createSpy().and.callFake(this.transform);
    var futureExpires = new Date(Date.now() + 60 * 60 * 1000).toUTCString();

    const firstResult = await this.transformer.lookup(this.url, firstTransform);

    const stringifiedHeaders = await client.get(headersKey);
    var headers;

    try {
      headers = JSON.parse(stringifiedHeaders) || {};
    } catch (e) {
      headers = {};
    }

    headers.expires = futureExpires;
    headers.url = this.url;

    await client.set(headersKey, JSON.stringify(headers));

    const secondResult = await this.transformer.lookup(
      this.url,
      secondTransform
    );

    expect(firstTransform).toHaveBeenCalled();
    expect(secondTransform).not.toHaveBeenCalled();
    expect(secondResult).toEqual(firstResult);
  });

  it("treats a response with only Cache-Control: max-age as fresh", async function () {
    var firstTransform = jasmine.createSpy().and.callFake(this.transform);
    var secondTransform = jasmine.createSpy().and.callFake(this.transform);

    // First response is cacheable for an hour via max-age alone (no Expires,
    // no ETag / Last-Modified). The second queued response has a different
    // body - if the transformer re-requests it, sizes will differ.
    this.queueRemoteResponse({
      body: "fresh body " + Date.now(),
      etag: null,
      lastModified: null,
      headers: { "Cache-Control": "max-age=3600" },
    });
    this.queueRemoteResponse({
      body: "this body should never be fetched " + Date.now(),
      etag: null,
      lastModified: null,
      headers: { "Cache-Control": "max-age=3600" },
    });

    const firstResult = await this.transformer.lookup(
      this.sequenceUrl,
      firstTransform
    );
    const secondResult = await this.transformer.lookup(
      this.sequenceUrl,
      secondTransform
    );

    expect(firstTransform).toHaveBeenCalled();
    expect(secondTransform).not.toHaveBeenCalled();
    expect(secondResult).toEqual(firstResult);
  });

  it("revalidates a no-cache response even when it carries a max-age", async function () {
    var firstTransform = jasmine.createSpy().and.callFake(this.transform);
    var secondTransform = jasmine.createSpy().and.callFake(this.transform);

    // no-cache means "revalidate before reuse", so the second lookup must
    // still hit the network despite the hour-long max-age. With no ETag /
    // Last-Modified the revalidation is a plain 200 with a new body, so the
    // transform runs again.
    this.queueRemoteResponse({
      body: "short " + Date.now(),
      etag: null,
      lastModified: null,
      headers: { "Cache-Control": "no-cache, max-age=3600" },
    });
    this.queueRemoteResponse({
      body: "a considerably longer second body " + Date.now(),
      etag: null,
      lastModified: null,
      headers: { "Cache-Control": "no-cache, max-age=3600" },
    });

    const firstResult = await this.transformer.lookup(
      this.sequenceUrl,
      firstTransform
    );
    const secondResult = await this.transformer.lookup(
      this.sequenceUrl,
      secondTransform
    );

    expect(firstTransform).toHaveBeenCalled();
    expect(secondTransform).toHaveBeenCalled();
    expect(secondResult.size).not.toEqual(firstResult.size);
  });

  it("accepts a gzip-encoded response whose Content-Length is the encoded size", async function () {
    var transform = jasmine.createSpy().and.callFake(this.transform);

    // A compressible body: the gzip Content-Length is far smaller than the
    // bytes the fetch-image job reads after decoding, which must not read as a
    // truncated download.
    this.queueRemoteResponse({
      gzip: true,
      body: "gzipped body ".repeat(64) + Date.now(),
      etag: null,
      lastModified: null,
    });

    const result = await this.transformer.lookup(this.sequenceUrl, transform);

    expect(transform).toHaveBeenCalled();
    expect(result.size).toEqual(jasmine.any(Number));
  });

  describe("url download caching", function () {
    it("stores the transformed result after a successful download", async function () {
      var body = "Initial response " + Date.now();
      var etag = '"seq-etag-' + Date.now() + '"';
      var lastModified = new Date().toUTCString();
      var firstTransform = jasmine.createSpy().and.callFake(this.transform);
      var secondTransform = jasmine.createSpy().and.callFake(this.transform);

      this.queueRemoteResponse({
        body: body,
        etag: etag,
        lastModified: lastModified,
      });
      this.queueRemoteResponse({
        status: 304,
        etag: etag,
        lastModified: lastModified,
      });

      const firstResult = await this.transformer.lookup(
        this.sequenceUrl,
        firstTransform
      );
      const secondResult = await this.transformer.lookup(
        this.sequenceUrl,
        secondTransform
      );

      expect(firstTransform).toHaveBeenCalled();
      expect(secondTransform).not.toHaveBeenCalled();
      expect(secondResult).toEqual(firstResult);
      expect(firstResult.size).toEqual(Buffer.byteLength(body));
    });

    it("overwrites the cached result after a subsequent successful download", async function () {
      var firstBody = "First body " + Date.now();
      var secondBody = "Second body " + Date.now();
      var firstEtag = '"seq-etag-' + Date.now() + '-1"';
      var secondEtag = '"seq-etag-' + Date.now() + '-2"';
      var firstModified = new Date().toUTCString();
      var secondModified = new Date(Date.now() + 1000).toUTCString();
      var firstTransform = jasmine.createSpy().and.callFake(this.transform);
      var secondTransform = jasmine.createSpy().and.callFake(this.transform);

      this.queueRemoteResponse({
        body: firstBody,
        etag: firstEtag,
        lastModified: firstModified,
      });
      this.queueRemoteResponse({
        body: secondBody,
        etag: secondEtag,
        lastModified: secondModified,
      });

      const firstResult = await this.transformer.lookup(
        this.sequenceUrl,
        firstTransform
      );
      const secondResult = await this.transformer.lookup(
        this.sequenceUrl,
        secondTransform
      );

      expect(firstTransform).toHaveBeenCalled();
      expect(secondTransform).toHaveBeenCalled();
      expect(secondResult.size).toEqual(Buffer.byteLength(secondBody));
      expect(secondResult.size).not.toEqual(firstResult.size);
    });

    it("returns the last successful result when a download fails", async function () {
      var firstBody = "First body " + Date.now();
      var secondBody = "Second body " + Date.now();
      var firstEtag = '"seq-etag-' + Date.now() + '-1"';
      var secondEtag = '"seq-etag-' + Date.now() + '-2"';
      var firstModified = new Date().toUTCString();
      var secondModified = new Date(Date.now() + 1000).toUTCString();
      var firstTransform = jasmine.createSpy().and.callFake(this.transform);
      var secondTransform = jasmine.createSpy().and.callFake(this.transform);
      var thirdTransform = jasmine.createSpy().and.callFake(this.transform);

      this.queueRemoteResponse({
        body: firstBody,
        etag: firstEtag,
        lastModified: firstModified,
      });
      this.queueRemoteResponse({
        body: secondBody,
        etag: secondEtag,
        lastModified: secondModified,
      });
      this.queueRemoteResponse({ status: 500 });

      await this.transformer.lookup(this.sequenceUrl, firstTransform);
      const secondResult = await this.transformer.lookup(
        this.sequenceUrl,
        secondTransform
      );
      const thirdResult = await this.transformer.lookup(
        this.sequenceUrl,
        thirdTransform
      );

      expect(firstTransform).toHaveBeenCalled();
      expect(secondTransform).toHaveBeenCalled();
      expect(thirdTransform).not.toHaveBeenCalled();
      expect(secondResult.size).toEqual(Buffer.byteLength(secondBody));
      expect(thirdResult).toEqual(secondResult);
    });

    it("errors instead of hanging when the connection drops mid-download", async function () {
      var spy = jasmine.createSpy().and.callFake(this.transform);

      this.queueRemoteResponse({ destroy: true });

      const err = await failure(this.transformer.lookup(this.sequenceUrl, spy));

      expect(err instanceof Error).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    }, 20000);

    it("falls back to the cached result when a later download drops mid-body", async function () {
      var body = "Good body " + Date.now();
      var firstTransform = jasmine.createSpy().and.callFake(this.transform);
      var secondTransform = jasmine.createSpy().and.callFake(this.transform);

      this.queueRemoteResponse({ body: body, etag: null, lastModified: null });
      this.queueRemoteResponse({ destroy: true });

      const firstResult = await this.transformer.lookup(
        this.sequenceUrl,
        firstTransform
      );
      const secondResult = await this.transformer.lookup(
        this.sequenceUrl,
        secondTransform
      );

      expect(firstTransform).toHaveBeenCalled();
      expect(secondTransform).not.toHaveBeenCalled();
      expect(secondResult).toEqual(firstResult);
    }, 20000);
  });
});
