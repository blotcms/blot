const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
const { samePixels, restoreIdentical } = require("../restore-identical");

const png = (rgb, compressionLevel = 6) =>
  sharp({
    create: { width: 4, height: 3, channels: 3, background: rgb },
  })
    .png({ compressionLevel })
    .toBuffer();

describe("qa/restore-identical", function () {
  it("compares decoded pixels, not bytes", async function () {
    const a = await png({ r: 10, g: 20, b: 30 }, 0);
    const b = await png({ r: 10, g: 20, b: 30 }, 9);
    expect(a.equals(b)).toBe(false);
    expect(await samePixels(a, b)).toBe(true);
    expect(await samePixels(a, await png({ r: 10, g: 20, b: 31 }))).toBe(false);
    expect(await samePixels(a, Buffer.from("not a png"))).toBe(false);
  });

  it("restores an identical image, keeps a changed one and a new one", async function () {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pane-restore-"));
    const git = (...args) => execFileSync("git", args, { cwd: repo });
    try {
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      const dir = path.join(repo, "rendered", "macos");
      fs.mkdirSync(dir, { recursive: true });
      const same = await png({ r: 1, g: 2, b: 3 }, 0);
      fs.writeFileSync(path.join(dir, "same.png"), same);
      fs.writeFileSync(
        path.join(dir, "changed.png"),
        await png({ r: 9, g: 9, b: 9 })
      );
      git("add", ".");
      git("commit", "-q", "-m", "first");

      // a new render: same pixels with other bytes, different pixels, and a new image
      const reencoded = await png({ r: 1, g: 2, b: 3 }, 9);
      fs.writeFileSync(path.join(dir, "same.png"), reencoded);
      fs.writeFileSync(
        path.join(dir, "changed.png"),
        await png({ r: 8, g: 8, b: 8 })
      );
      fs.writeFileSync(path.join(dir, "new.png"), reencoded);

      const restored = await restoreIdentical(path.join(repo, "rendered"));
      expect(restored).toEqual(["rendered/macos/same.png"]);
      expect(fs.readFileSync(path.join(dir, "same.png")).equals(same)).toBe(
        true
      );
      git("add", "-A");
      const staged = git("diff", "--cached", "--name-only").toString().trim();
      expect(staged.split("\n").sort()).toEqual([
        "rendered/macos/changed.png",
        "rendered/macos/new.png",
      ]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
