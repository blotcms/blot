describe("icloud toiCloud empty files", function () {
  const toiCloudPath = require.resolve("../toiCloud");
  const modules = {
    checkWeCanContinue: require.resolve("../util/checkWeCanContinue"),
    remoteUpload: require.resolve("../util/remoteUpload"),
    remoteMkdir: require.resolve("../util/remoteMkdir"),
    remoteDelete: require.resolve("../util/remoteDelete"),
    localReaddir: require.resolve("../util/localReaddir"),
    remoteReaddir: require.resolve("../util/remoteReaddir"),
  };
  const originals = new Map();
  let uploads;
  let messages;

  function mock(path, exportsValue) {
    if (!originals.has(path)) originals.set(path, require.cache[path]);
    require.cache[path] = {
      id: path,
      filename: path,
      loaded: true,
      exports: exportsValue,
    };
  }

  function load(local, remote) {
    mock(modules.checkWeCanContinue, () => async () => {});
    mock(modules.remoteUpload, async (_blogID, path) => uploads.push(path));
    mock(modules.remoteMkdir, async () => {});
    mock(modules.remoteDelete, async () => {});
    mock(modules.localReaddir, async () => local);
    mock(modules.remoteReaddir, async () => remote);
    delete require.cache[toiCloudPath];
    return require(toiCloudPath);
  }

  beforeEach(function () {
    uploads = [];
    messages = [];
  });

  afterEach(function () {
    originals.forEach(function (cached, path) {
      if (cached) require.cache[path] = cached;
      else delete require.cache[path];
    });
    originals.clear();
    delete require.cache[toiCloudPath];
  });

  const local = [
    { name: "empty.pdf", size: 0, isDirectory: false },
    { name: "overwrites.pdf", size: 0, isDirectory: false },
    { name: "post.txt", size: 5, isDirectory: false },
  ];
  const remote = [{ name: "overwrites.pdf", size: 9000, isDirectory: false }];

  it("skips empty files when skipEmptyFiles is set, leaving the remote file alone", async function () {
    const toiCloud = load(local, remote);

    await toiCloud("blog", (...args) => messages.push(args.join(" ")), null, {
      skipDeletions: true,
      skipEmptyFiles: true,
    });

    expect(uploads).toEqual(["/post.txt"]);
    expect(messages.some((m) => /Skipped 2 empty files/.test(m))).toBe(true);
  });

  it("uploads empty files on an ordinary sync", async function () {
    const toiCloud = load(local, remote);

    await toiCloud("blog", () => {}, null, { skipDeletions: true });

    expect(uploads.sort()).toEqual([
      "/empty.pdf",
      "/overwrites.pdf",
      "/post.txt",
    ]);
  });
});
