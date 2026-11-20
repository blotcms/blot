// blogFolder.js says where each blog's shared folder is: blog_<id> itself
// (the old layout) or the folder nested inside it under the owner's name,
// which follows the owner's renames (#2874).
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

describe("icloud macserver blogFolder", function () {
  // config.js reads these once per process, so this uses the same iCloud
  // Drive as the other macserver specs (the temporary directory), with blog
  // IDs of its own
  const root = os.tmpdir();
  let blogFolder;
  let blogID;

  beforeAll(async function () {
    const env = {
      REMOTE_SERVER: "http://127.0.0.1:9",
      ICLOUD_DRIVE_DIRECTORY: root,
      BLOT_ICLOUD_SERVER_SECRET: "test-secret",
    };
    const previous = {};
    for (const key in env) {
      previous[key] = process.env[key];
      if (!process.env[key]) process.env[key] = env[key];
    }
    try {
      blogFolder = await import(
        pathToFileURL(path.join(__dirname, "../macserver/blogFolder.js")).href
      );
    } finally {
      for (const key in previous) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  beforeEach(function () {
    blogFolder._reset();
    blogID = "blog_spec" + Math.random().toString(36).slice(2, 10);
  });

  afterEach(async function () {
    await fs.remove(path.join(root, blogID));
    await fs.remove(path.join(root, "My site " + blogID));
  });

  const container = () => path.join(blogFolder.containerPath(blogID));

  it("treats blog_<id> without the marker as the shared folder itself", async function () {
    await fs.outputFile(path.join(container(), "post.md"), "hello");
    const layout = await blogFolder.refresh(blogID);

    expect(layout.nested).toBe(false);
    expect(blogFolder.rootOf(blogID)).toBe(container());
    expect(blogFolder.locate(path.join(container(), "a/post.md"))).toEqual({
      blogID,
      path: "a/post.md",
    });
    expect(blogFolder.locate(container())).toEqual({ blogID, path: "" });
  });

  it("nests a shared folder under its owner's name", async function () {
    const shared = path.join(root, "My site " + blogID);
    await fs.outputFile(path.join(shared, "post.md"), "hello");

    const layout = await blogFolder.nest(blogID, shared);

    expect(layout.name).toBe("My site " + blogID);
    expect(await fs.pathExists(shared)).toBe(false);
    expect(await fs.pathExists(path.join(container(), blogFolder.MARKER))).toBe(
      true
    );
    expect(blogFolder.rootOf(blogID)).toBe(path.join(container(), layout.name));
    expect(blogFolder.folderNameOf(blogID)).toBe(layout.name);
    expect(
      blogFolder.locate(path.join(container(), layout.name, "posts/a.md"))
    ).toEqual({ blogID, path: "posts/a.md" });
    // blog_<id> itself, the marker, and the folder under another name are
    // all "the blog folder" for the watcher to check
    expect(blogFolder.locate(container()).path).toBe("");
    expect(
      blogFolder.locate(path.join(container(), blogFolder.MARKER)).path
    ).toBe("");
    expect(
      blogFolder.locate(path.join(container(), "Old name", "post.md")).path
    ).toBe("");
  });

  it("follows a rename of the nested folder", async function () {
    const shared = path.join(root, "My site " + blogID);
    await fs.outputFile(path.join(shared, "post.md"), "hello");
    const { name } = await blogFolder.nest(blogID, shared);

    await fs.rename(
      path.join(container(), name),
      path.join(container(), "Renamed")
    );
    const layout = await blogFolder.refresh(blogID);

    expect(layout.name).toBe("Renamed");
    expect(layout.renamedFrom).toBe(name);
    expect(blogFolder.rootOf(blogID)).toBe(path.join(container(), "Renamed"));
    expect((await blogFolder.refresh(blogID)).renamedFrom).toBe(null);
  });

  it("keeps no root when a nested blog_<id> holds no folder, or several", async function () {
    await fs.outputFile(path.join(container(), blogFolder.MARKER), "");
    let layout = await blogFolder.refresh(blogID);
    expect(layout.nested).toBe(true);
    expect(layout.root).toBe(null);
    // still nested: its files must not go to blog_<id> in the folder's place
    expect(blogFolder.isNested(blogID)).toBe(true);
    expect(() => blogFolder.rootOf(blogID)).toThrowError(/gone/);
    expect(
      blogFolder.locate(path.join(container(), "Old name", "post.md"))
    ).toEqual({ blogID, path: "" });

    await fs.mkdirp(path.join(container(), "One"));
    await fs.mkdirp(path.join(container(), "Two"));
    layout = await blogFolder.refresh(blogID);
    expect(layout.root).toBe(null);
  });

  it("won't nest into an old blog folder or one that holds a folder", async function () {
    await fs.outputFile(path.join(container(), "post.md"), "hello");
    const shared = path.join(root, "My site " + blogID);
    await fs.mkdirp(shared);

    await expectAsync(blogFolder.nest(blogID, shared)).toBeRejected();
    expect(await fs.pathExists(shared)).toBe(true);
  });

  it("clears Finder's dot-files when removing a nested blog_<id>", async function () {
    await fs.outputFile(path.join(container(), blogFolder.MARKER), "");
    await fs.outputFile(path.join(container(), ".DS_Store"), "x");
    await blogFolder.refresh(blogID);

    expect(await blogFolder.removeContainer(blogID)).toBe(true);
    expect(await fs.pathExists(container())).toBe(false);
    expect(blogFolder.isNested(blogID)).toBe(false);
  });

  it("lists nested blogs' names at startup", async function () {
    const shared = path.join(root, "My site " + blogID);
    await fs.mkdirp(shared);
    await blogFolder.nest(blogID, shared);
    blogFolder._reset();

    const found = await blogFolder.refreshAll();
    expect(found).toContain({ blogID, name: "My site " + blogID });
  });

  it("removes an empty nested blog_<id>, and refuses one that isn't", async function () {
    const shared = path.join(root, "My site " + blogID);
    await fs.mkdirp(shared);
    const { root: nestedRoot } = await blogFolder.nest(blogID, shared);

    await expectAsync(blogFolder.removeContainer(blogID)).toBeRejected();
    expect(await fs.pathExists(nestedRoot)).toBe(true);

    await fs.remove(nestedRoot);
    expect(await blogFolder.removeContainer(blogID)).toBe(true);
    expect(await fs.pathExists(container())).toBe(false);
  });
});
