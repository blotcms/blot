// Clearing scratch directories a killed process left behind: only old ones,
// only by name, and never an error for one that is already gone.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sweepScratch } = require("../leftovers");

const HOUR = 60 * 60 * 1000;

describe("git store leftovers", function () {
  let root;
  const NOW = Date.now();

  // A directory with a file in it, and every mtime set to `ageMs` before NOW
  function make(name, ageMs, bytes = 10) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "pack"), Buffer.alloc(bytes));
    const when = new Date(NOW - ageMs);
    fs.utimesSync(path.join(dir, "pack"), when, when);
    fs.utimesSync(dir, when, when);
    return dir;
  }

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "leftovers-spec-"));
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes old import, verify and rewrite directories and counts the bytes", async function () {
    const dirs = [make("import-a1B2c3", 30 * HOUR, 100), make("verify-a1B2c3", 30 * HOUR, 200), make("rewrite-a1B2c3", 30 * HOUR, 300)];

    const result = await sweepScratch({ dir: root, now: NOW });

    expect(result).toEqual({ removed: 3, spared: 0, bytes: 600, errors: 0 });
    dirs.forEach((dir) => expect(fs.existsSync(dir)).toBe(false));
  });

  it("keeps a recent directory, and one whose contents are recent", async function () {
    const recent = make("import-aaaaaa", HOUR);
    const busy = make("verify-bbbbbb", 30 * HOUR);
    fs.writeFileSync(path.join(busy, "tmp.pack"), "x");
    const old = new Date(NOW - 30 * HOUR);
    fs.utimesSync(busy, old, old);

    const result = await sweepScratch({ dir: root, now: NOW });

    expect(result.removed).toBe(0);
    expect(result.spared).toBe(2);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(busy)).toBe(true);
  });

  it("leaves unrelated directories, files and links alone", async function () {
    const others = [make("git-store", 30 * HOUR), make("import-short", 30 * HOUR), make("important-abcdef", 30 * HOUR), make("cache-a1B2c3", 30 * HOUR)];
    const file = path.join(root, "import-a1B2c3");
    fs.writeFileSync(file, "x");
    const target = make("elsewhere", 30 * HOUR);
    fs.symlinkSync(target, path.join(root, "verify-a1B2c3"));

    const result = await sweepScratch({ dir: root, now: NOW });

    expect(result).toEqual({ removed: 0, spared: 0, bytes: 0, errors: 0 });
    others.concat([file, target]).forEach((p) => expect(fs.existsSync(p)).toBe(true));
  });

  it("does nothing when the scratch directory does not exist", async function () {
    expect(await sweepScratch({ dir: path.join(root, "missing"), now: NOW })).toEqual({ removed: 0, spared: 0, bytes: 0, errors: 0 });
  });

  it("does not throw when a directory is removed underneath it", async function () {
    const dir = make("import-gone01", 30 * HOUR);
    make("verify-stay02", 30 * HOUR);
    const rm = fs.promises.rm;
    // Another process removes the directory between the look and the removal
    spyOn(fs.promises, "rm").and.callFake(async function (target, options) {
      await rm(target, options);
      const error = Object.assign(new Error("gone"), { code: "ENOENT" });
      if (target === dir) throw error;
      return undefined;
    });

    const result = await sweepScratch({ dir: root, now: NOW });

    expect(result.errors).toBe(0);
    expect(result.removed).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
