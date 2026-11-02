module.exports = function setup(options) {
  var Transformer = require("../index");
  var fs = require("fs-extra");
  var Express = require("express");
  var server = Express();
  var responseBody = "Hello, World!";
  var etag = '"test-etag"';
  var lastModified = new Date("2020-01-01T00:00:00Z").toUTCString();
  var sequenceQueue = [];
  var zlib = require("zlib");

  // A remote URL must serve an image now (the sandbox's fetch-image job
  // refuses anything else), so each text body is served as a PNG as many
  // pixels wide as the text is long: different bodies stay different images,
  // and the transform below reads the length back from the width.
  var CRC_TABLE = Array.from({ length: 256 }, function (_, n) {
    for (var k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });

  function crc32(buffer) {
    var crc = 0xffffffff;
    for (var i = 0; i < buffer.length; i++) {
      crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    var length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    var body = Buffer.concat([Buffer.from(type), data]);
    var crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  }

  function imageFor(text) {
    var width = Math.max(1, Buffer.byteLength(text));
    var header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8; // bit depth
    header[9] = 0; // greyscale
    var row = Buffer.alloc(width + 1); // a filter byte, then the pixels
    return Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", header),
      chunk("IDAT", zlib.deflateSync(row)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  var PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

  // Only server an image at this route if
  // the request passes the correct query
  server.get("/foo.html", function (req, res) {
    res.set({
      "Cache-Control": "max-age=0, must-revalidate",
      ETag: etag,
      "Last-Modified": lastModified,
    });

    var ifNoneMatch = req.get("If-None-Match");
    var ifModifiedSince = req.get("If-Modified-Since");

    if (ifNoneMatch === etag || ifModifiedSince === lastModified) {
      return res.status(304).end();
    }

    res.type("png").send(imageFor(responseBody));
  });

  server.get("/sequence", function (req, res) {
    if (!sequenceQueue.length) {
      return res.status(500).send("No queued response");
    }

    var config = sequenceQueue.shift() || {};

    // Simulate the connection dropping part-way through the body: promise
    // the client 1000 bytes, send a handful, then kill the socket.
    if (config.destroy) {
      res.set({ "Content-Length": "1000" });
      res.write("partial");
      return res.socket.destroy();
    }

    var status = config.status === undefined ? 200 : config.status;
    var body = config.body === undefined ? responseBody : config.body;
    var etagValue =
      config.etag === undefined ? etag : config.etag;
    var lastModifiedValue =
      config.lastModified === undefined ? lastModified : config.lastModified;
    var headers = Object.assign(
      { "Cache-Control": "max-age=0, must-revalidate" },
      config.headers || {}
    );

    if (etagValue) headers.ETag = etagValue;
    if (lastModifiedValue) headers["Last-Modified"] = lastModifiedValue;

    res.set(headers);

    if (status === 304) return res.status(304).end();

    res.status(status);

    if (status >= 400) return res.send(config.body || "");

    // Serve the body gzip-encoded: Content-Length then describes the
    // compressed size, which is smaller than the bytes the fetch-image job
    // reads after decoding.
    if (config.gzip) {
      var gz = zlib.gzipSync(imageFor(body));
      res.set({
        "Content-Encoding": "gzip",
        "Content-Length": String(gz.length),
      });
      return res.end(gz);
    }

    res.type("png").send(imageFor(body));
  });

  // Create temporary blog before each test, clean up after
  global.test.blog();

  // Sets up a temporary tmp folder, cleans it up after
  global.test.tmp();

  beforeEach(function () {
    // This simulates me using the transformer to perform
    // some task that I don't want to repeat needlessly.
    // In reality, it might be the function which turns
    // an image into thumbnails, or the function which
    // A downloaded image's size is its width, the length of the text it
    // stands for (see imageFor above).
    this.transform = function (path, done) {
      fs.readFile(path, function (err, contents) {
        if (err) return done(err);

        if (contents.subarray(0, 8).equals(PNG_SIGNATURE)) {
          return done(null, { size: contents.readUInt32BE(16) });
        }

        done(null, { size: contents.length });
      });
    };

    // This represents the cache of previous transformations
    // stored for a given blog. "transformer" is just a label
    this.transformer = new Transformer(this.blog.id, "transformer");

    // Create a test file to use for the transformer
    this.path = "foo.txt";
    this.localPath = this.blogDirectory + "/" + this.path;
    fs.outputFileSync(this.localPath, "Hello, World !" + Date.now());

    sequenceQueue.length = 0;
    this.sequenceUrl = this.origin + "/sequence";
    this.queueRemoteResponse = function (config) {
      sequenceQueue.push(config || {});
    };
  });

  // Clean up the transformer used in each test
  afterEach(function (done) {
    this.transformer.flush(done);
  });

  global.test.server(server);

  // Create a webserver for testing remote files
  beforeAll(function () {
    this.url = this.origin + "/foo.html";
  });
};
