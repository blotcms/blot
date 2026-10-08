const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseSample } = require("../../../app/scheduler/check-redis-host");

// Runs bin/tcpmem-log.sh against fake /proc files and a fake redis6-cli, df and
// mountpoint, and checks the app's scheduler can read the sample it stores.
describe("tcpmem-log.sh", function () {
  const SCRIPT = path.join(__dirname, "..", "bin", "tcpmem-log.sh");
  let root;

  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tcpmem-log-"));

    write(
      "proc/net/sockstat",
      "sockets: used 120\nTCP: inuse 20 orphan 0 tw 3 alloc 25 mem 1234\nUDP: inuse 2 mem 4\n"
    );
    write("proc/sys/net/ipv4/tcp_mem", "1600000\t1800000\t2000000\n");
    write(
      "proc/net/netstat",
      [
        "TcpExt: PruneCalled TCPMemoryPressures TCPMemoryPressuresChrono TCPRcvQDrop TCPOFODrop",
        "TcpExt: 7 1 4210 3 2",
        "IpExt: InNoRoutes InTruncatedPkts",
        "IpExt: 0 0",
        "",
      ].join("\n")
    );

    write("proc/meminfo", "MemTotal:       16000000 kB\nMemFree: 100 kB\nMemAvailable:   12000000 kB\n");

    // df -P -k: the root disk is 1,024,000,000 bytes (256,000,000 used); a
    // separate /backups is twice that with twice as much used
    write(
      "bin/df",
      `#!/bin/sh
for last; do :; done
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
case "$last" in
  */backups) echo "/dev/nvme1n1 2000000 500000 1500000 25% /backups" ;;
  *) echo "/dev/nvme0n1p1 1000000 250000 750000 25% /" ;;
esac
`
    );
    // /backups is a mount if the test creates a "backups-mounted" file
    write("bin/mountpoint", `#!/bin/sh\n[ -e "${root}/backups-mounted" ]\n`);
    ["df", "mountpoint"].forEach((name) => fs.chmodSync(path.join(root, "bin", name), 0o755));

    // Records its arguments, one per line
    write(
      "bin/redis6-cli",
      `#!/bin/sh\nfor arg in "$@"; do echo "$arg"; done > "${root}/cli-args"\n`
    );
    fs.chmodSync(path.join(root, "bin/redis6-cli"), 0o755);
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = () =>
    execFileSync("sh", [SCRIPT], {
      env: {
        ...process.env,
        HOME: root,
        BLOT_ROOT: root,
        PATH: path.join(root, "bin") + ":" + process.env.PATH,
      },
    });

  const cliArgs = () =>
    fs.readFileSync(path.join(root, "cli-args"), "utf8").trimEnd().split("\n");

  it("logs the sample as before", function () {
    run();
    const log = fs.readFileSync(path.join(root, "tcpmem.log"), "utf8");
    expect(log).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ mem=1234 tcp_mem=1600000,1800000,2000000 sockets=25 pressures=1 chrono_ms=4210 prune=7 rcvq_drop=3 ofo_drop=2\n$/
    );
  });

  it("stores the sample in Redis for the app to read", function () {
    run();
    const [command, key, value] = cliArgs();
    const logged = fs.readFileSync(path.join(root, "tcpmem.log"), "utf8").trim();

    expect([command, key]).toEqual(["SET", "blot:redis-host:tcpmem"]);
    expect(value.startsWith(`${logged} host=${os.hostname()} active=0 `)).toBe(true);

    const sample = parseSample(value);
    expect(sample.mem).toBe(1234);
    expect(sample.tcpMem).toEqual([1600000, 1800000, 2000000]);
    expect(sample.pressures).toBe(1);
    expect(sample.sockets).toBe(25);
    expect(sample.active).toBe(false);
    expect(Math.abs(Date.now() - sample.time)).toBeLessThan(60 * 1000);
  });

  it("reports the host's RAM and disk space in bytes, and leaves them out of the log", function () {
    run();
    const value = cliArgs()[2];

    expect(value).toMatch(
      / active=0 ram_total=16384000000 ram_avail=12288000000 disk_root=256000000\/1024000000$/
    );
    expect(fs.readFileSync(path.join(root, "tcpmem.log"), "utf8")).not.toContain("ram_total");

    const sample = parseSample(value);
    expect(sample.ramTotal).toBe(16384000000);
    expect(sample.ramAvailable).toBe(12288000000);
    expect(sample.diskRoot).toEqual({ used: 256000000, total: 1024000000 });
    expect(sample.diskBackups).toBe(null);
  });

  it("reports /backups when it is a mount", function () {
    write("backups-mounted", "");
    run();
    const value = cliArgs()[2];

    expect(value).toMatch(/ disk_root=256000000\/1024000000 disk_backups=512000000\/2048000000$/);
    expect(parseSample(value).diskBackups).toEqual({ used: 512000000, total: 2048000000 });
  });

  it("leaves out the fields it cannot read", function () {
    fs.rmSync(path.join(root, "proc/meminfo"));
    write("bin/df", "#!/bin/sh\nexit 1\n");
    run();
    const value = cliArgs()[2];

    expect(value).not.toMatch(/ram_|disk_/);
    expect(parseSample(value).mem).toBe(1234);
    expect(parseSample(value).ramTotal).toBe(null);
  });

  it("marks the host active once cutover has written the floating IP", function () {
    write("etc/blot-redis/floating-ip", "10.0.0.50\n");
    run();
    expect(parseSample(cliArgs()[2]).active).toBe(true);
  });

  it("still logs when Redis refuses the write", function () {
    write("bin/redis6-cli", '#!/bin/sh\necho "READONLY You can\'t write against a read only replica."\nexit 1\n');
    expect(run().toString()).toBe("");
    expect(fs.readFileSync(path.join(root, "tcpmem.log"), "utf8")).toContain("mem=1234");
  });
});
