describe("icloud toiCloud empty files and placeholders", function () {
  const toiCloudPath = require.resolve("../toiCloud");
  const modules = {
    checkWeCanContinue: require.resolve("../util/checkWeCanContinue"),
    remoteUpload: require.resolve("../util/remoteUpload"),
    remoteMkdir: require.resolve("../util/remoteMkdir"),
    remoteDelete: require.resolve("../util/remoteDelete"),
    localReaddir: require.resolve("../util/localReaddir"),
    remoteReaddir: require.resolve("../util/remoteReaddir"),
    folder: require.resolve("storage/folder"),
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

  function load(local, remote, placeholders = []) {
    mock(modules.checkWeCanContinue, () => async () => {});
    mock(modules.remoteUpload, async (_blogID, path) => uploads.push(path));
    mock(modules.remoteMkdir, async () => {});
    mock(modules.remoteDelete, async () => {});
    mock(modules.localReaddir, async () => local);
    mock(modules.remoteReaddir, async () => remote);
    mock(modules.folder, {
      stat: async (_blogID, path) =>
        placeholders.includes(path) ? { placeholder: true } : {},
    });
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
    { name: "placeholder.pdf", size: 0, isDirectory: false },
    { name: "empty.txt", size: 0, isDirectory: false },
    { name: "overwrites.pdf", size: 0, isDirectory: false },
    { name: "post.txt", size: 5, isDirectory: false },
  ];
  const remote = [{ name: "overwrites.pdf", size: 9000, isDirectory: false }];

  it("skips placeholders, uploads empty files, and never overwrites a remote file with one", async function () {
    const toiCloud = load(local, remote, ["/placeholder.pdf"]);

    await toiCloud("blog", (...args) => messages.push(args.join(" ")), null, {
      skipDeletions: true,
    });

    expect(uploads.sort()).toEqual(["/empty.txt", "/post.txt"]);
    expect(messages.some((m) => /Skipped 1 placeholder /.test(m))).toBe(true);
  });
});
