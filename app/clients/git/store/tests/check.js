// Checking a repository at an explicit target (check.js, through
// scripts/git/check-store.js), as the offsite restore test does: a real
// repository imported into a folder, then broken in the ways a restore could
// break it. The script never writes to what it checks.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const fx = require("./helpers/fixture");
const timeout = require("./helpers/timeout");
const manifest = require("../manifest");
const importRepo = require("../import");
const removeRepo = require("../remove");
const createCache = require("../cache");
const createFsStore = require("../objectStore/fs");
const { packKey, idxKey, manifestKey } = require("../layout");

const MiB = 1024 * 1024;
const script = path.join(__dirname, "..", "..", "..", "..", "..", "scripts", "git", "check-store.js");

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// Every file under dir, with its size and modification time
function listing(dir) {
  const out = [];
  (function walk(at) {
    for (const name of fs.readdirSync(at).sort()) {
      const file = path.join(at, name);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file);
      else out.push(path.relative(dir, file) + ":" + stat.size + ":" + stat.mtimeMs);
    }
  })(dir);
  return out;
}

describe("checking a store repository at an explicit target", function () {
  timeout(60 * 1000);

  let root;
  let counter = 0;
  let imported;
  const unique = (name) => path.join(root, name + "-" + ++counter);

  beforeAll(async function () {
    root = fx.tempDir();

    const source = unique("source");
    fs.mkdirSync(source);
    fx.git(source, ["init", "-q", "-b", "master"]);
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(source, "post-" + i + ".md"), "# Post " + i + "\n" + "line\n".repeat(100 * i));
      fx.git(source, ["add", "-A"]);
      fx.git(source, ["commit", "-q", "-m", "Commit " + i]);
    }
    fx.git(source, ["tag", "-a", "-m", "First", "v1"]);
    fx.git(source, ["branch", "dev"]);

    imported = unique("imported");
    const cache = createCache({ dir: unique("cache"), maxBytes: 64 * MiB });
    const result = await importRepo({ store: createFsStore({ root: imported }), cache, lock: (fn) => fn(), gitDir: path.join(source, ".git") });
    expect(result.outcome).toBe("imported");
  });

  afterAll(function () {
    fx.remove(root);
  });

  // A copy of the imported repository, as <blogID>/git/ under `under`
  function restored(under = unique("restore"), blogID = "blog_" + counter) {
    const dir = path.join(under, blogID, "git");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(imported, dir, { recursive: true });
    return dir;
  }

  it("passes an imported repository, cheap and deep, without writing to it", async function () {
    const dir = restored();
    const before = listing(dir);
    const current = await manifest.read(createFsStore({ root: dir }));

    const cheap = await run(["--dir", dir]);
    expect(cheap.code).toBe(0, cheap.stderr);
    const result = JSON.parse(cheap.stdout);
    expect(result.outcome).toBe("ok");
    expect(result.deep).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.seq).toBe(current.seq);
    expect(result.refs).toBe(3);
    expect(result.packs).toBe(current.packs.length);
    expect(result.bytes).toBeGreaterThan(0);

    const deep = await run(["--dir", dir, "--deep", "--scratch", unique("scratch")]);
    expect(deep.code).toBe(0, deep.stderr);
    const deeply = JSON.parse(deep.stdout);    expect(deeply.outcome).toBe("ok");
    expect(deeply.deep).toBe(true);
    expect(deeply.objects).toBeGreaterThan(0);

    expect(listing(dir)).toEqual(before);
  });

  it("finds a missing pack and a truncated .idx", async function () {
    const dir = restored();
    const current = await manifest.read(createFsStore({ root: dir }));
    const pack = current.packs[0];
    const history = current.history || current.packs[current.packs.length - 1];
    fs.rmSync(path.join(dir, packKey(pack.name)));
    fs.truncateSync(path.join(dir, idxKey(history.name)), history.idxSize - 10);

    const { code, stdout } = await run(["--dir", dir, "--deep"]);
    expect(code).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.outcome).toBe("findings");
    expect(result.deep).toBe(false);
    const found = result.findings.map((finding) => finding.check + " " + finding.kind + " " + finding.detail.split(" ")[0]);
    expect(found).toContain("cheap missing " + packKey(pack.name));
    expect(found).toContain("cheap mismatch " + idxKey(history.name));
  });

  it("finds a missing manifest", async function () {
    const dir = restored();
    const current = await manifest.read(createFsStore({ root: dir }));
    fs.rmSync(path.join(dir, manifestKey(current.seq)));

    const { code, stdout } = await run(["--dir", dir]);
    expect(code).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.outcome).toBe("findings");
    expect(result.findings[0].kind).toBe("missing");
    expect(result.findings[0].detail).toContain(manifestKey(current.seq));
  });

  it("reports a tombstone as removed and no repository as empty", async function () {
    const dir = restored();
    expect((await removeRepo({ store: createFsStore({ root: dir }) })).outcome).toBe("removed");

    const removed = await run(["--dir", dir, "--deep"]);
    expect(removed.code).toBe(0, removed.stderr);
    expect(JSON.parse(removed.stdout).outcome).toBe("removed");

    const nothing = unique("empty");
    fs.mkdirSync(nothing);
    const empty = await run(["--dir", nothing]);
    expect(empty.code).toBe(0, empty.stderr);
    expect(JSON.parse(empty.stdout).outcome).toBe("empty");
  });

  it("checks every blog under a restored root, one line each and a summary", async function () {
    const under = unique("restore");
    restored(under, "blog_good");
    const broken = restored(under, "blog_broken");
    const current = await manifest.read(createFsStore({ root: broken }));
    fs.rmSync(path.join(broken, packKey(current.packs[0].name)));
    fs.mkdirSync(path.join(under, "blog_nogit"));

    const { code, stdout } = await run(["--dir", under, "--all-blogs"]);
    expect(code).toBe(1);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.length).toBe(3);
    expect(lines.slice(0, 2).map((line) => line.blog + " " + line.outcome)).toEqual(["blog_broken findings", "blog_good ok"]);
    const summary = lines[2];
    expect(summary.summary).toBe(true);
    expect(summary.blogs).toBe(2);
    expect(summary.outcomes).toEqual({ ok: 1, findings: 1, empty: 0, removed: 0 });
    expect(summary.withFindings.map((blog) => blog.blog)).toEqual(["blog_broken"]);
  });

  it("exits 2 for bad arguments", async function () {
    expect((await run([])).code).toBe(2);
    expect((await run(["--dir", unique("nowhere")])).code).toBe(2);
    expect((await run(["--bucket", "b", "--all-blogs"])).code).toBe(2);
    expect((await run(["--dir", root, "--wat"])).code).toBe(2);
  });
});
