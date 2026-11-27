// Run by the pane-qa workflow's commit job after it copied the renders over rendered/ and before it
// stages them: restores every PNG whose decoded pixels equal the committed version's. A render's bytes
// differ between runs (encoder, metadata) even when its pixels don't, and each commit the bot pushes
// holds the branch's CI as action_required. A new file has no committed version and is kept.
//
//   node qa/restore-identical.js [directory]     (default: rendered/, next to this folder)

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const decode = async (input) => {
  const { data, info } = await sharp(input)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, ch: info.channels };
};

// do two PNGs (as buffers) show the same pixels? Anything unreadable counts as different.
async function samePixels(a, b) {
  try {
    const [x, y] = await Promise.all([decode(a), decode(b)]);
    return (
      x.width === y.width &&
      x.height === y.height &&
      x.ch === y.ch &&
      x.data.equals(y.data)
    );
  } catch (err) {
    return false;
  }
}

const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"], // a new file's "not in HEAD" is expected, not noise
  });

// Restores the identical PNGs under `dir` (inside a git work tree) from HEAD; returns their paths.
async function restoreIdentical(dir) {
  dir = fs.realpathSync(dir); // git reports the real path (macOS's /tmp is a symlink)
  const root = git(dir, ["rev-parse", "--show-toplevel"]).toString().trim();
  const files = fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".png"))
    .map((f) => path.join(dir, f));
  const restored = [];
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    let committed;
    try {
      committed = git(root, ["show", `HEAD:${rel}`]);
    } catch (err) {
      continue; // new file: keep it
    }
    if (await samePixels(fs.readFileSync(file), committed)) {
      git(root, ["checkout", "--", rel]);
      restored.push(rel);
    }
  }
  return restored;
}

module.exports = { samePixels, restoreIdentical };

if (require.main === module) {
  const dir = path.resolve(
    process.argv[2] || path.join(__dirname, "..", "rendered")
  );
  restoreIdentical(dir).then(
    (restored) =>
      console.log(`restored ${restored.length} image(s) with unchanged pixels`),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
