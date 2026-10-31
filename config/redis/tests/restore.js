const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// restore.sh list, with ssh and aws stubbed to print a bucket listing. The
// stubs log their arguments to calls.log. restore.sh is bash (it runs on an
// operator's Mac) and the test image has none, so this is skipped there.
describe("restore.sh", function () {
  const SCRIPT = path.join(__dirname, "..", "restore.sh");
  const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-"));
    const stub = (name) =>
      fs.writeFileSync(
        path.join(dir, name),
        `#!/bin/sh
echo "${name} $*" >> "${path.join(dir, "calls.log")}"
cat <<'LISTING'
2026-10-30 03:05:10 100 daily/2026-10-30-hour-03.rdb
2026-10-30 04:00:10 100 hourly/2026-10-30-hour-04.rdb
2026-10-25 03:35:10 100 weekly/2026-10-25-hour-03.rdb
2026-10-24 03:35:10 100 other/2026-10-24-hour-03.rdb
LISTING
`,
        { mode: 0o755 }
      );
    stub("ssh");
    stub("aws");
  });

  function run(args) {
    return spawnSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: dir + ":" + process.env.PATH },
    });
  }

  function calls() {
    const log = path.join(dir, "calls.log");
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  }

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

  it("lists offsite backups with the local aws and never asks the host", function () {
    if (!hasBash) return pending("no bash in this image");

    const result = run(["--offsite", "blot-b2-read", "s3://example", "ec2-user@host", "list"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("daily/2026-10-30-hour-03.rdb");
    expect(result.stdout).not.toContain("other/");
    expect(calls()).toContain("aws --profile blot-b2-read s3 ls --recursive s3://example/");
    expect(calls()).not.toContain("ssh");
  });

  it("refuses a bad offsite bucket or profile", function () {
    if (!hasBash) return pending("no bash in this image");

    const bucket = run(["--offsite", "blot-b2-read", "example", "ec2-user@host", "list"]);
    const chars = run(["--offsite", "blot-b2-read", "s3://ex;ample", "ec2-user@host", "list"]);
    const profile = run(["--offsite", "bad profile", "s3://example", "ec2-user@host", "list"]);

    expect(bucket.status).not.toBe(0);
    expect(chars.status).not.toBe(0);
    expect(profile.status).not.toBe(0);
    expect(calls()).toBe("");
  });

  it("refuses --offsite without both values", function () {
    if (!hasBash) return pending("no bash in this image");

    expect(run(["--offsite"]).status).not.toBe(0);
    expect(run(["--offsite", "blot-b2-read"]).status).not.toBe(0);
    expect(calls()).toBe("");
  });
});
