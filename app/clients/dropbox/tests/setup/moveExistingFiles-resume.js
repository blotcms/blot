// A second blog's setup moves the first blog's files from the root of the
// app folder into a subfolder. A deploy or crash can cut that move short, so
// the subfolder is recorded first and a later run finishes the move into it.
describe("dropbox createFolder moveExistingFiles resumes", function () {
  const createFolderPath = require.resolve("../../routes/setup/createFolder");
  const databasePath = require.resolve("clients/dropbox/database");
  const syncPath = require.resolve("sync");
  const paths = [createFolderPath, databasePath, syncPath];
  const otherBlog = { id: "blog_moveresume", title: "Other blog" };
  const originals = {};

  let account, writes, calls;

  beforeEach(function () {
    paths.forEach((path) => (originals[path] = require.cache[path]));
    writes = [];
    calls = [];
  });

  afterEach(function () {
    paths.forEach((path) => {
      if (originals[path]) require.cache[path] = originals[path];
      else delete require.cache[path];
    });
  });

  function load(syncImpl = async (blogID, fn) => fn({})) {
    require.cache[syncPath] = {
      exports: syncImpl,
    };
    require.cache[databasePath] = {
      exports: {
        get: async () => account,
        set: async (blogID, changes) => {
          writes.push(changes);
          Object.assign(account, changes);
        },
      },
    };
    delete require.cache[createFolderPath];
    return require("../../routes/setup/createFolder").moveExistingFiles;
  }

  function client(root, { metadata } = {}) {
    return {
      filesCreateFolder: async ({ path }) => {
        calls.push(["create", path]);
        return { result: { id: "id:new", path_display: path } };
      },
      filesGetMetadata: async ({ path }) => {
        calls.push(["metadata", path]);
        if (metadata) return metadata();
        return { result: { ".tag": "folder", path_display: "/Other blog" } };
      },
      filesListFolder: async () => ({ result: { entries: root } }),
      filesMoveBatch: async ({ entries }) => {
        calls.push(["move", entries]);
        return { result: { async_job_id: "job" } };
      },
      filesMoveBatchCheck: async () => ({ result: { ".tag": "complete" } }),
    };
  }

  it("records the subfolder before it moves anything", async function () {
    account = {
      folder: "",
      folder_id: "",
      move_folder: "",
      move_folder_id: "",
    };
    const moveExistingFiles = load();
    const dropbox = client([
      { id: "id:post", name: "post.txt", path_display: "/post.txt" },
    ]);
    const move = dropbox.filesMoveBatch;
    dropbox.filesMoveBatch = async (arg) => {
      expect(account.move_folder_id).toBe("id:new");
      expect(account.move_folder).toBe("/Other blog");
      return move(arg);
    };

    await moveExistingFiles(dropbox, otherBlog);

    expect(writes[writes.length - 1]).toEqual({
      folder: "/Other blog",
      folder_id: "id:new",
      cursor: "",
      move_folder: "",
      move_folder_id: "",
    });
  });

  it("finishes a move cut short into the subfolder it recorded", async function () {
    account = {
      folder: "",
      folder_id: "",
      move_folder: "/Other blog",
      move_folder_id: "id:recorded",
    };
    const moveExistingFiles = load();

    await moveExistingFiles(
      client([
        // Moved before the cut, so it stays where it is
        { id: "id:recorded", name: "Other blog", path_display: "/Other blog" },
        { id: "id:left", name: "left.txt", path_display: "/left.txt" },
      ]),
      otherBlog
    );

    expect(calls.filter((c) => c[0] === "create")).toEqual([]);
    expect(calls.find((c) => c[0] === "move")[1]).toEqual([
      { from_path: "/left.txt", to_path: "/Other blog/left.txt" },
    ]);
    expect(account.folder_id).toBe("id:recorded");
    expect(account.move_folder_id).toBe("");
  });

  it("starts a new subfolder if the recorded one is gone", async function () {
    account = {
      folder: "",
      folder_id: "",
      move_folder: "/Other blog",
      move_folder_id: "id:gone",
    };
    const moveExistingFiles = load();
    const notFound = new Error("not found");
    notFound.status = 409;
    notFound.error = { error_summary: "path/not_found/.." };

    await moveExistingFiles(
      client([], {
        metadata: () => {
          throw notFound;
        },
      }),
      otherBlog
    );

    expect(calls.filter((c) => c[0] === "create").length).toBe(1);
    expect(account.folder_id).toBe("id:new");
  });

  it("waits for the other blog's lock instead of failing", async function () {
    account = {
      folder: "",
      folder_id: "",
      move_folder: "",
      move_folder_id: "",
    };
    let busy = 2;
    const moveExistingFiles = load(async (blogID, fn) => {
      if (busy-- > 0) {
        throw new Error("Failed to acquire folder lock", {
          cause: Object.assign(new Error("held"), { code: "ELOCKED" }),
        });
      }
      return fn({});
    });

    await moveExistingFiles(client([]), otherBlog, { retryMs: 1 });

    expect(busy).toBe(-1);
    expect(account.folder).toBe("/Other blog");
  });

  it("does not retry other errors", async function () {
    account = {
      folder: "",
      folder_id: "",
      move_folder: "",
      move_folder_id: "",
    };
    let runs = 0;
    const moveExistingFiles = load(async () => {
      runs++;
      throw new Error("Cannot sync blog");
    });

    await expectAsync(
      moveExistingFiles(client([]), otherBlog, { retryMs: 1 })
    ).toBeRejectedWith(new Error("Cannot sync blog"));
    expect(runs).toBe(1);
  });

  it("pauses the blog's syncs while a move is recorded", function () {
    const { transferIncomplete } = require("clients/dropbox/util/constants");
    expect(transferIncomplete({ move_folder_id: "id:recorded" })).toBe(true);
    expect(transferIncomplete({ move_folder_id: "" })).toBe(false);
  });

  it("leaves a blog alone once its move is done", async function () {
    account = {
      folder: "/Other blog",
      folder_id: "id:done",
      move_folder_id: "",
    };
    const moveExistingFiles = load();

    await moveExistingFiles(client([]), otherBlog, { resume: true });
    await moveExistingFiles(client([]), otherBlog);

    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
  });
});
