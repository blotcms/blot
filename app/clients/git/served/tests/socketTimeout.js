// A stalled connection to S3 fails the store's request fast (#2259). The
// store is the one a blog gets from served/context.js, on storage/s3's client
// for it, talking to a server in this spec which goes quiet.
describe("git store: S3 socket timeout", function () {
  const http = require("http");
  const config = require("config");
  const context = require("../context");
  const s3 = require("storage/s3");

  const TIMEOUT = 300;
  const saved = {};
  let server;
  let behave;
  let sockets;

  function listen() {
    return new Promise(function (resolve) {
      server = http.createServer(function (req, res) {
        behave(req, res);
      });
      server.on("connection", function (socket) {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.listen(0, "127.0.0.1", resolve);
    });
  }

  beforeEach(async function () {
    sockets = new Set();
    await listen();

    saved.storage = config.storage;
    saved.aws = config.aws;
    saved.timeout = config.git_store.s3_socket_timeout_ms;

    config.storage = Object.assign({}, config.storage, {
      bucket: "stalled",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:" + server.address().port,
    });
    config.aws = Object.assign({}, config.aws, {
      key: "test",
      secret: "test",
    });
    config.git_store.s3_socket_timeout_ms = TIMEOUT;
    s3.reset();
  });

  afterEach(async function () {
    config.storage = saved.storage;
    config.aws = saved.aws;
    config.git_store.s3_socket_timeout_ms = saved.timeout;
    s3.reset();

    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  async function fails(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    throw new Error("Expected the request to fail");
  }

  it("fails a request which gets no answer", async function () {
    // Accepts the request and says nothing
    behave = function () {};

    const store = context.objectStoreFor("blog_x");
    const started = Date.now();
    const err = await fails(store.head("manifest.json"));

    expect(err.name).toBe("TimeoutError");
    // The SDK tries a few times, each one giving up after the timeout
    expect(Date.now() - started).toBeLessThan(10 * 1000);
  });

  it("fails a read whose body stops part way, after the store's retries", async function () {
    let requests = 0;

    behave = function (req, res) {
      requests++;
      res.writeHead(200, { "content-length": 100 });
      res.write("abc");
    };

    const store = context.objectStoreFor("blog_x");
    const started = Date.now();
    const err = await fails(store.read("pack.pack", 0, 100));

    // The error's shape for a body cut off by the timeout differs between
    // Node versions (a TimeoutError, or the SDK's own wrapping of the
    // destroyed response), so it is the failing, fast and retried that count
    expect(err instanceof Error).toBe(true);
    expect(Date.now() - started).toBeLessThan(20 * 1000);
    // The store's read starts again before giving up (READ_ATTEMPTS)
    expect(requests).toBeGreaterThanOrEqual(3);
  });

  it("does not limit how long a request takes while bytes arrive", async function () {
    // Ten bytes, one every 100 ms: a second in all, over three times the
    // timeout, but never quiet for longer than a third of it
    behave = function (req, res) {
      res.writeHead(200, { "content-length": 10 });
      let sent = 0;
      const timer = setInterval(function () {
        res.write("x");
        if (++sent === 10) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
      res.on("close", () => clearInterval(timer));
    };

    const store = context.objectStoreFor("blog_x");
    const started = Date.now();
    const bytes = await store.read("pack.pack", 0, 10);

    expect(bytes.toString()).toBe("xxxxxxxxxx");
    expect(Date.now() - started).toBeGreaterThan(TIMEOUT);
  });
});
