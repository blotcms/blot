const fs = require("fs-extra");
const localPath = require("helper/localPath");

// The hourly sweep only walks blogs the macserver pushed to in the last hour,
// so the routes it drives must stamp lastSync - and nothing else may.
describe("icloud routes stamp lastSync", function () {
  const routeNames = ["upload", "delete", "mkdir", "status"];
  const paths = {
    stamp: require.resolve("../stampLastSync"),
    lock: require.resolve("sync/establishSyncLock"),
    database: require.resolve("../../../database"),
    initialTransfer: require.resolve("../../../sync/initialTransfer"),
    fromiCloud: require.resolve("../../../sync/fromiCloud"),
    email: require.resolve("helper/email"),
    blog: require.resolve("models/blog"),
    entries: require.resolve("models/entries"),
    fix: require.resolve("sync/fix"),
    getHealth: require.resolve("../../../getHealth"),
    validateBlog: require.resolve("../../../sync/validateBlog"),
  };
  routeNames.forEach((name) => (paths[name] = require.resolve("../" + name)));

  const originals = {};
  let blogID;
  let stamped;
  let walked;

  const stub = (name, exports) => {
    require.cache[paths[name]] = {
      id: paths[name],
      filename: paths[name],
      loaded: true,
      exports,
    };
  };

  const fakeReq = (headers, body) => ({
    header: (name) => headers[name],
    body,
  });

  const fakeRes = () => {
    const res = {
      statusCode: null,
      headersSent: false,
      status(code) {
        res.statusCode = code;
        return res;
      },
      send() {
        return res;
      },
      sendStatus(code) {
        res.statusCode = code;
        return res;
      },
      set() {
        return res;
      },
    };
    return res;
  };

  const pathHeaders = (path) => ({
    blogID,
    pathBase64: Buffer.from(path).toString("base64"),
  });

  beforeEach(async function () {
    Object.keys(paths).forEach((name) => {
      originals[name] = require.cache[paths[name]];
    });

    blogID = `icloud-stamp-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    await fs.ensureDir(localPath(blogID, "/"));
    stamped = [];
    walked = [];

    stub("stamp", async (id) => stamped.push(id));
    stub("lock", async () => ({
      folder: { status: () => {}, update: async () => {} },
      done: async () => {},
    }));
    stub("database", {
      store: async () => {},
      get: async () => ({
        sharingLink: "https://www.icloud.com/iclouddrive/x",
        setupComplete: true,
      }),
    });
    stub("initialTransfer", async () => {});
    stub("fromiCloud", async (id) => {
      walked.push(id);
      return {};
    });
    stub("email", { ICLOUD_RESYNC_ISSUE: (_, locals, callback) => callback() });
    stub("blog", {
      get: ({ id }, callback) => callback(null, { id, client: "icloud" }),
    });
    stub("entries", { getAllTotal: (_id, callback) => callback(null, 0) });
    stub("fix", (blog, callback) => callback(null, {}));
    stub("getHealth", async () => ({ issues: [] }));
    // Reload each route, and the walk and Fix() it runs, bound to the stubs
    // above
    delete require.cache[paths.validateBlog];
    routeNames.forEach((name) => delete require.cache[paths[name]]);
  });

  afterEach(async function () {
    Object.keys(paths).forEach((name) => {
      if (originals[name]) require.cache[paths[name]] = originals[name];
      else delete require.cache[paths[name]];
    });
    await fs.remove(localPath(blogID, "/"));
  });

  it("/upload stamps the blog", async function () {
    await require(paths.upload)(
      fakeReq(pathHeaders("/post.txt"), Buffer.from("hello")),
      fakeRes()
    );

    expect(stamped).toEqual([blogID]);
  });

  it("/upload doesn't stamp for an ignored file", async function () {
    await require(paths.upload)(
      fakeReq(pathHeaders("/.DS_Store"), Buffer.from("hello")),
      fakeRes()
    );

    expect(stamped).toEqual([]);
  });

  it("/delete stamps the blog", async function () {
    await fs.outputFile(localPath(blogID, "/post.txt"), "hello");

    await require(paths.delete)(fakeReq(pathHeaders("/post.txt")), fakeRes());

    expect(stamped).toEqual([blogID]);
  });

  it("/mkdir stamps the blog", async function () {
    await require(paths.mkdir)(fakeReq(pathHeaders("/Posts")), fakeRes());

    expect(stamped).toEqual([blogID]);
  });

  it("/status stamps the blog when the macserver requests a resync", async function () {
    await require(paths.status)(
      fakeReq({ blogID }, { resyncRequested: true }),
      fakeRes()
    );

    expect(walked).toEqual([blogID]);
    expect(stamped).toEqual([blogID]);
  });

  it("/status doesn't stamp for an ordinary status update", async function () {
    await require(paths.status)(
      fakeReq({ blogID }, { setupComplete: true }),
      fakeRes()
    );

    expect(stamped).toEqual([]);
  });

  it("a failing stamp doesn't fail the route", async function () {
    delete require.cache[paths.stamp];
    stub("database", {
      stampLastSync: async () => {
        throw new Error("redis down");
      },
    });
    delete require.cache[paths.upload];
    spyOn(console, "error");

    const res = fakeRes();
    await require(paths.upload)(
      fakeReq(pathHeaders("/post.txt"), Buffer.from("hello")),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(await fs.pathExists(localPath(blogID, "/post.txt"))).toBe(true);
  });
});
