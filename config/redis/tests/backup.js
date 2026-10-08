const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseBackup, BACKUP_KEY } = require("../../../app/scheduler/daily/redis-server");

// Runs bin/backup.sh against a fake root and fake redis6-cli, aws, flock,
// mountpoint, rsync and ip, and checks it records each upload in Redis for the
// app's daily email. The test image has no bash, so the script runs under sh
// (it is written to work in both).
describe("backup.sh", function () {
  const SCRIPT = path.join(__dirname, "..", "bin", "backup.sh");
  let root;

  const file = (name) => path.join(root, name);
  const write = (name, text, mode) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), text);
    if (mode) fs.chmodSync(file(name), mode);
  };
  const stub = (name, body) => write(`bin/${name}`, `#!/bin/sh\n${body}\n`, 0o755);
  const read = (name) => fs.readFileSync(file(name), "utf8");

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-"));

    write("var/lib/redis6/dump.rdb", "x".repeat(1234));
    write("tmp/.keep", "");
    write("etc/blot-redis/floating-ip", "10.0.0.50\n");

    // The floating IP is on this host
    stub("../usr/sbin/ip", "echo '2: eth0    inet 10.0.0.50/32 scope global eth0'");
    stub("flock", "exit 0");
    stub("mountpoint", "exit 1"); // no instance store unless a test changes it
    stub("rsync", 'for last; do :; done; cp "$2" "$last"');
    // Records its arguments
    stub("aws", `echo "$@" >> "${root}/aws-calls"`);
    stub(
      "redis6-cli",
      `
case "$*" in
  "INFO server") echo "redis_version:6.2.12" ;;
  "INFO replication") printf 'role:master\\r\\nmin_slaves_good_slaves:0\\r\\n' ;;
  "INFO persistence") printf 'loading:0\\r\\nrdb_bgsave_in_progress:0\\r\\nrdb_last_bgsave_status:ok\\r\\n' ;;
  "CONFIG GET min-replicas-to-write") printf 'min-replicas-to-write\\r\\n0\\r\\n' ;;
  LASTSAVE) date +%s ;;
  SET*) for arg in "$@"; do echo "$arg"; done > "${root}/set-args"; eval "\${SET_COMMAND:-:}" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`
    );
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (kind = "hourly", env = {}) =>
    spawnSync("sh", [SCRIPT, kind], {
      encoding: "utf8",
      env: {
        ...process.env,
        BLOT_ROOT: root,
        BLOT_BACKUP_BUCKET: "s3://test-bucket",
        PATH: path.join(root, "bin") + ":" + process.env.PATH,
        ...env,
      },
    });

  const setArgs = () => read("set-args").trimEnd().split("\n");

  it("records the upload in Redis for the app to read", function () {
    const result = run("hourly");
    // The script names it with the host's local time
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const name = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-hour-${pad(now.getHours())}`;

    expect(result.status).toBe(0);
    expect(read("aws-calls")).toContain(`s3 cp --only-show-errors ${root}/var/lib/redis6/dump.rdb s3://test-bucket/hourly/${name}.rdb`);

    const [command, key, value] = setArgs();
    expect([command, key]).toEqual(["SET", BACKUP_KEY]);
    expect(value).toMatch(
      new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ hourly hourly/${name}\\.rdb 1234$`)
    );

    const backup = parseBackup(value);
    expect(backup.kind).toBe("hourly");
    expect(backup.key).toBe(`hourly/${name}.rdb`);
    expect(backup.bytes).toBe(1234);
    expect(Math.abs(Date.now() - backup.time)).toBeLessThan(60 * 1000);
  });

  it("records the size of the local copy when /backups is a mount", function () {
    stub("mountpoint", "exit 0");
    const result = run("daily");

    expect(result.status).toBe(0);
    expect(setArgs()[2]).toMatch(/ daily daily\/\d{4}-\d\d-\d\d-hour-\d\d\.rdb 1234$/);
    expect(read("aws-calls")).toContain(`${root}/backups/`);
  });

  it("does not fail the backup when Redis refuses the write", function () {
    const result = run("hourly", { SET_COMMAND: "echo READONLY; exit 1" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("could not record the backup in Redis");
    expect(result.stdout).toContain("hourly backup: done");
  });

  it("records nothing when the upload fails", function () {
    stub("aws", "exit 1");
    const result = run("hourly");

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(file("set-args"))).toBe(false);
  });

  it("records nothing when the host is not the active one", function () {
    fs.rmSync(file("etc/blot-redis/floating-ip"));
    const result = run("hourly");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped: not marked as the active host");
    expect(fs.existsSync(file("aws-calls"))).toBe(false);
    expect(fs.existsSync(file("set-args"))).toBe(false);
  });
});
