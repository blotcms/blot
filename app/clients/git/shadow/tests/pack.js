// The pack a mirror makes reaches receive whole, however late receive starts
// reading it. A mirror push was refused with "missing necessary objects" and
// accepted on the retry when packFor handed receive git's stdout itself: a
// small pack's git exited before receive had reserved scratch, and Node
// drained the unread stdout into nothing (see packFor in ../index.js).
describe("git store shadow mode: the pack a mirror makes", function () {
  var fs = require("fs");
  var os = require("os");
  var path = require("path");
  var { spawn, spawnSync } = require("child_process");
  var shadow = require("clients/git/shadow");

  function run(dir, args) {
    var result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com"].concat(args), {
      cwd: dir,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error("git " + args.join(" ") + ": " + result.stderr);
    return result.stdout.trim();
  }

  async function readAll(stream) {
    var chunks = [];
    for await (var chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  beforeEach(function () {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-pack-"));
    run(this.dir, ["init", "-q"]);
    fs.writeFileSync(path.join(this.dir, "a.txt"), "A");
    run(this.dir, ["add", "a.txt"]);
    run(this.dir, ["commit", "-q", "-m", "A"]);
    this.gitDir = path.join(this.dir, ".git");
    this.tip = run(this.dir, ["rev-parse", "HEAD"]);
  });

  afterEach(function () {
    fs.rmSync(this.dir, { recursive: true, force: true });
  });

  it("is whole when git has exited before it is read", async function () {
    var pack = shadow._packFor(this.gitDir, [this.tip], []);

    expect((await pack.exited).code).toBe(0);

    var bytes = await readAll(pack.stream);
    expect(bytes.subarray(0, 4).toString()).toBe("PACK");
    expect(bytes.readUInt32BE(8)).toBe(3); // the commit, its tree and a.txt
    expect((await pack.done()).code).toBe(0);
  });

  // Why: Node's own behaviour, which packFor has to work around. If this
  // starts failing, Node no longer drains an unread stdout on exit, and the
  // spec can go; the one above must stay.
  it("would be empty if git's stdout were read only after git exited", async function () {
    var child = spawn("git", ["pack-objects", "--revs", "--stdout", "-q"], {
      env: Object.assign({}, process.env, { GIT_DIR: this.gitDir }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    var closed = new Promise(function (resolve) {
      child.on("close", resolve);
    });

    child.stderr.resume();
    child.stdin.end(this.tip + "\n");

    expect(await closed).toBe(0);
    expect((await readAll(child.stdout)).length).toBe(0);
  });
});
