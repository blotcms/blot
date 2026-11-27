// Disconnect takes a blog's shared folder off the macserver through Finder's
// own Delete, never by deleting its files, which would delete them for the
// folder's owner too. These specs stand in for Finder.
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

describe("icloud macserver leaveFolder", function () {
  let leaveFolder;
  let checkPath;
  let script;
  let root;

  beforeAll(async function () {
    ({
      default: leaveFolder,
      checkPath,
      script,
    } = await import(
      pathToFileURL(path.join(__dirname, "../macserver/util/leaveFolder.js"))
        .href
    ));
  });

  beforeEach(async function () {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "leave-folder-"));
    // A blog folder: blog_<id> holds the marker and the shared folder
    await fs.outputFile(path.join(root, "blog_abc", ".blot-nested"), "");
    await fs.outputFile(path.join(shared(), "post.txt"), "hello");
  });

  afterEach(async function () {
    await fs.remove(root);
  });

  const shared = () => path.join(root, "blog_abc", "My site");
  const options = (run) => ({ run, root, waitMs: 50, pollMs: 10 });

  // What Finder does once the sheet is confirmed: the folder leaves whole
  const finder = (outcome) =>
    jasmine.createSpy("run").and.callFake(async (command, args) => {
      if (args[1] === script) await fs.move(args[3], path.join(root, "gone"));
      return { stdout: outcome + "\n" };
    });

  describe("checkPath", function () {
    it("accepts the shared folder inside a blog folder", function () {
      expect(checkPath(shared(), root)).toBe(shared());
    });

    [
      ["iCloud Drive itself", ""],
      ["a folder that isn't a blog's", "Sites"],
      ["blog_<id> itself, which holds the shared folder", "blog_abc"],
      ["the marker", "blog_abc/.blot-nested"],
      ["a folder inside the shared folder", "blog_abc/My site/posts"],
      ["a path that climbs out", "blog_abc/../../etc"],
      ["a blog ID with other characters", "blog_ab c/My site"],
    ].forEach(function ([name, relative]) {
      it(`refuses ${name}`, function () {
        expect(() => checkPath(path.join(root, relative), root)).toThrowError(
          /Refusing to remove/
        );
      });
    });

    it("refuses a blog_ folder without the marker, and any folder in it", async function () {
      await fs.outputFile(path.join(root, "blog_old", "drafts", "a.md"), "");
      expect(() => checkPath(path.join(root, "blog_old"), root)).toThrowError(
        /Refusing to remove/
      );
      expect(() =>
        checkPath(path.join(root, "blog_old", "drafts"), root)
      ).toThrowError(/Refusing to remove/);
    });
  });

  it("refuses a bad path before running anything", async function () {
    const run = jasmine.createSpy("run");
    let error;

    try {
      await leaveFolder(root, options(run));
    } catch (err) {
      error = err;
    }

    expect(error.message).toContain("Refusing to remove");
    expect(run).not.toHaveBeenCalled();
  });

  it("confirms Finder's sheet for a shared folder, leaving the Trash alone", async function () {
    const run = finder("confirmed");
    const target = shared();

    expect(await leaveFolder(target, options(run))).toBe(true);

    expect(run.calls.count()).toBe(1);
    expect(run.calls.argsFor(0)[1]).toEqual(["-e", script, "My site", target]);
    // the files left with the folder, not one by one
    expect(await fs.pathExists(path.join(root, "gone", "post.txt"))).toBe(true);
  });

  it("empties the Trash after a folder that wasn't shared", async function () {
    const run = finder("no sheet");

    await leaveFolder(shared(), options(run));

    expect(run.calls.count()).toBe(2);
    expect(run.calls.argsFor(1)[1][1]).toContain("empty the trash");
  });

  it("throws when Finder's checks abort, leaving the folder", async function () {
    const run = jasmine
      .createSpy("run")
      .and.returnValue(Promise.resolve({ stdout: "abort: 2 items selected" }));
    let error;

    try {
      await leaveFolder(shared(), options(run));
    } catch (err) {
      error = err;
    }

    expect(error.message).toContain("abort: 2 items selected");
    expect(await fs.pathExists(path.join(shared(), "post.txt"))).toBe(true);
  });

  it("throws when the folder is still there after Finder", async function () {
    const run = jasmine
      .createSpy("run")
      .and.returnValue(Promise.resolve({ stdout: "confirmed" }));
    let error;

    try {
      await leaveFolder(shared(), options(run));
    } catch (err) {
      error = err;
    }

    expect(error.message).toContain("still there");
    expect(run.calls.count()).toBe(1);
  });

  it("does nothing for a folder that isn't there", async function () {
    const run = jasmine.createSpy("run");

    expect(
      await leaveFolder(path.join(root, "blog_abc", "Gone"), options(run))
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("checks the selection and frontmost app before pressing a key", function () {
    const keystroke = script.indexOf("keystroke");
    expect(script.indexOf("items selected")).toBeLessThan(keystroke);
    expect(script.indexOf("abort: selected")).toBeLessThan(keystroke);
    expect(script.indexOf("is not frontmost")).toBeLessThan(keystroke);
    // the variable must not be called target: Finder has a property by that name
    expect(script).not.toMatch(/\btarget\b/);
  });
});
