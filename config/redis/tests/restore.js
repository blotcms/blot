const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// restore.sh list, with ssh stubbed to print a bucket listing. restore.sh is
// bash (it runs on an operator's Mac) and the test image has none, so this is
// skipped there.
describe("restore.sh", function () {
  const SCRIPT = path.join(__dirname, "..", "restore.sh");
  const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-"));
    fs.writeFileSync(
      path.join(dir, "ssh"),
      `#!/bin/sh
cat <<'LISTING'
2026-10-30 03:05:10 100 daily/2026-10-30-hour-03.rdb
2026-10-30 04:00:10 100 hourly/2026-10-30-hour-04.rdb
2026-10-25 03:35:10 100 weekly/2026-10-25-hour-03.rdb
2026-10-24 03:35:10 100 other/2026-10-24-hour-03.rdb
LISTING
`,
      { mode: 0o755 }
    );
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists hourly, daily and weekly backups", function () {
    if (!hasBash) return pending("no bash in this image");

    const result = spawnSync("bash", [SCRIPT, "ec2-user@host", "list"], {
      encoding: "utf8",
      env: { ...process.env, PATH: dir + ":" + process.env.PATH },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("weekly/2026-10-25-hour-03.rdb");
    expect(result.stdout).toContain("daily/2026-10-30-hour-03.rdb");
    expect(result.stdout).toContain("hourly/2026-10-30-hour-04.rdb");
    expect(result.stdout).not.toContain("other/");
  });
});
