const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseSample } = require("../../../app/scheduler/check-redis-host");

// Runs bin/tcpmem-log.sh against fake /proc files and a fake redis6-cli, and
// checks the app's scheduler can read the sample it stores.
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
    expect(value).toBe(`${logged} host=${os.hostname()} active=0`);

    const sample = parseSample(value);
    expect(sample.mem).toBe(1234);
    expect(sample.tcpMem).toEqual([1600000, 1800000, 2000000]);
    expect(sample.pressures).toBe(1);
    expect(sample.sockets).toBe(25);
    expect(sample.active).toBe(false);
    expect(Math.abs(Date.now() - sample.time)).toBeLessThan(60 * 1000);
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
