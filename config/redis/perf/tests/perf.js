const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawnSync, execFile } = require("child_process");

const writeSyntheticLogs = require("./synthetic-logs");
const compare = require("../compare");

// The collectors run on Amazon Linux (bash, python3, a real /proc). The test
// image is slimmer than that, so each shell or python spec skips itself when
// its tools are missing. compare.js is plain node and always runs.
const PERF = path.join(__dirname, "..");
const has = (cmd) => spawnSync("sh", ["-c", "command -v " + cmd], { stdio: "ignore" }).status === 0;
const skipUnless = (...cmds) => {
  const missing = cmds.filter((c) => !has(c));
  if (missing.length) pending("needs " + missing.join(", "));
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "blot-perf-"));
const write = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};

describe("redis perf tools", function () {
  describe("compare.js", function () {
    let dir;
    beforeAll(function () {
      dir = tmp();
      writeSyntheticLogs(dir);
    });
    afterAll(function () {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("parses windows, including a bare end time on the start's date", function () {
      const w = compare.parseWindow("2026-10-08T13:00..16:30");
      expect(new Date(w.from).toISOString()).toBe("2026-10-08T13:00:00.000Z");
      expect(new Date(w.to).toISOString()).toBe("2026-10-08T16:30:00.000Z");
      // an end that is not later than the start is the next day
      expect(new Date(compare.parseWindow("2026-10-08T22:00..02").to).toISOString()).toBe("2026-10-09T02:00:00.000Z");
      expect(() => compare.parseWindow("nonsense")).toThrow();
    });

    it("parses a log line, with x as null", function () {
      const r = compare.parseLine("2026-10-08T12:00:00Z a=1 b=x c=ok d=-1");
      expect(r.f).toEqual({ a: 1, b: null, c: "ok", d: -1 });
    });

    it("compares the same hours of two days and splits latency by BGSAVE", function () {
      const out = compare.main([
        "--data", dir,
        "--baseline", "2026-10-07T00:00..2026-10-08T00:00",
        "--test", "2026-10-08T12:00..16:00",
        "--match-hours",
      ]);
      expect(out).toContain("hours 12,13,14,15");
      expect(out).toContain("[BGSAVE running] minutes");
      expect(out).toContain("[no BGSAVE] minutes");
      const line = (label) => out.split("\n").find((l) => l.startsWith(label));
      // the synthetic squeeze triples the probe p99 and the burst time, adds
      // 4x the BGSAVE time on the test side and slow heartbeats
      expect(line("p99 per minute")).toMatch(/0\.750 \/ 1 \/ 1 \/ 1\s+2\.25 \/ 3 \/ 3 \/ 3/);
      expect(line("duration, s")).toMatch(/30 \/ 30 \/ 30 \/ 30\s+45 \/ 45 \/ 45 \/ 45/);
      expect(line("[LOCK] slow heartbeat lines")).toMatch(/0\s+48/);
      expect(line("cpu0 busy")).toMatch(/25 \/ 30 \/ 30 \/ 30\s+65 \/ 70 \/ 70 \/ 70/);
    });

    // Collector logs for two days in which every minute of 12:00-13:00 is sampled.
    // sample(day, m) and probe(label, day, m) give the lines; the test supplies them.
    const iso = (t) => new Date(t).toISOString().slice(0, 19) + "Z";
    const day = (d) => Date.UTC(2026, 9, d, 12, 0);
    const writeLogs = (dir, { sample, probes, locks, dt }) => {
      const lines = { "redis/redis-sample.log": [], "redis/latency-redis-local.log": [], "app/latency-app-to-redis.log": [] };
      for (const d of [7, 8]) {
        for (let m = 0; m < 60; m++) {
          lines["redis/redis-sample.log"].push(iso(day(d) + (m + 1) * 60000) + " dt=" + (dt ? dt(d, m) : 60) + " " + sample(d, m));
          for (const label of Object.keys(probes)) {
            const f = probes[label](d, m);
            if (f) lines[label === "redis-local" ? "redis/latency-redis-local.log" : "app/latency-app-to-redis.log"].push(iso(day(d) + m * 60000) + " label=" + label + " " + f);
          }
        }
      }
      if (locks) lines["app/app-lock.log"] = locks;
      for (const file of Object.keys(lines)) write(path.join(dir, file), lines[file].join("\n") + "\n");
    };
    const probeFields = (p50) => `n=1000 err=0 reconn=0 conn_ms=0.2 p50=${p50} p90=${p50} p99=${p50} p999=${p50} max=${p50} gt10=0 gt50=0 gt100=0 gt1000=0 burst_ms=20 burst_n=17857`;
    // the lines of one section of the output, as { label: [baseline, test] }
    const section = (out, heading) => {
      const rows = {};
      let inside = false;
      for (const l of out.split("\n")) {
        if (l.startsWith("== ")) inside = l.startsWith("== " + heading);
        else if (inside && l.trim()) {
          const cols = l.trim().split(/\s{2,}/);
          rows[cols[0]] = cols.slice(1);
        }
      }
      return rows;
    };

    it("keeps rows aligned by label when the windows differ in shape", function () {
      const dir = tmp();
      writeLogs(dir, {
        // steal and psi only in the test day; the redis-local probe only on the baseline day
        sample: (d, m) => `cpu0_busy=20 cpu0_steal=${d === 8 ? 3 : 0} cpu1_busy=${d === 8 ? 50 : 10} tcpmem=${d === 8 ? "x" : 100} bgsave_status=ok` + (d === 8 ? " psi10=1.5 psi60=1.0" : ""),
        probes: {
          "redis-local": (d) => (d === 7 ? probeFields(1) : null),
          "app-to-redis": (d) => probeFields(d === 8 ? 2 : 1),
        },
      });
      const out = compare.main(["--data", dir, "--baseline", "2026-10-07T12:00..13:00", "--test", "2026-10-08T12:00..13:00"]);

      // a sample stamped 13:00 covers 12:59-13:00, so it is in the 12:00-13:00 window
      expect(section(out, "Window")["one-minute samples"]).toEqual(["60", "60"]);

      const cpu = section(out, "CPU");
      expect(cpu["cpu0 steal"]).toEqual(["-", "3 / 3 / 3 / 3"]);
      expect(cpu["cpu0 busy"]).toEqual(["20 / 20 / 20 / 20", "20 / 20 / 20 / 20"]);
      expect(cpu["cpu1 busy"]).toEqual(["10 / 10 / 10 / 10", "50 / 50 / 50 / 50"]);
      expect(cpu["CPU pressure some avg10, %"]).toEqual(["not available", "1.50 / 1.50 / 1.50 / 1.50"]);

      // the redis-local probe has no rows in the test window; the next section must not shift
      expect(section(out, "Latency probe: redis-local")["probe minutes"]).toEqual(["60", "0"]);
      expect(section(out, "Latency probe: redis-local")["p50 per minute"]).toEqual(["1 / 1 / 1 / 1", "-"]);
      const remote = section(out, "Latency probe: app-to-redis");
      expect(remote["probe minutes"]).toEqual(["60", "60"]);
      expect(remote["p50 per minute"]).toEqual(["1 / 1 / 1 / 1", "2 / 2 / 2 / 2"]);
      expect(remote["250KB burst (burst_ms)"]).toEqual(["20 / 20 / 20 / 20", "20 / 20 / 20 / 20"]);
      expect(section(out, "TCP memory")["min / mean / max"]).toEqual(["100 / 100 / 100", "-"]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("leaves out samples that cover a long gap and says how many", function () {
      const dir = tmp();
      // the sample after a 10 minute cron gap has counters from outside the window
      writeLogs(dir, { sample: () => "cmds=6000", dt: (d, m) => (d === 8 && m === 30 ? 600 : 60), probes: {} });
      const out = compare.main(["--data", dir, "--baseline", "2026-10-07T12:00..13:00", "--test", "2026-10-08T12:00..13:00"]);
      const win = section(out, "Window");
      expect(win["one-minute samples"]).toEqual(["60", "59"]);
      expect(win["samples dropped (gap over 90s)"]).toEqual(["-", "1"]);
      expect(section(out, "Redis")["commands/s"]).toEqual(["100 / 100 / 100 / 100", "100 / 100 / 100 / 100"]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("counts failed saves as changes of status to err, not minutes in err", function () {
      const dir = tmp();
      // err from minute 10 to 24 (started before the test window), then 30,
      // an x, 32, and again at 51 after an ok
      const err = (m) => (m >= 10 && m <= 24) || m === 30 || m === 32 || m === 51;
      writeLogs(dir, { sample: (d, m) => "bgsave_status=" + (d === 7 ? "ok" : m === 31 ? "x" : err(m) ? "err" : "ok"), probes: {} });
      const out = compare.main(["--data", dir, "--baseline", "2026-10-07T12:20..13:00", "--test", "2026-10-08T12:20..13:00"]);
      const bgsave = section(out, "BGSAVE");
      expect(bgsave["failed saves (status went to err)"]).toEqual(["0", "2"]);
      expect(bgsave["minutes with last save failed"]).toEqual(["0", "8"]);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("refuses to pick between several log directories", function () {
      const d = tmp();
      for (const host of ["old-host", "new-host"]) {
        write(path.join(d, host, "redis-sample.log"), "2026-10-08T12:00:00Z dt=60\n");
        write(path.join(d, host, "latency-app-to-redis.log"), "");
      }
      const args = ["--data", d, "--baseline", "2026-10-07..2026-10-08", "--test", "2026-10-08..2026-10-09"];
      expect(() => compare.main(args)).toThrowError(/more than one directory.*new-host, old-host.*--redis-dir/);
      // naming the Redis directory is not enough: the app one is still ambiguous
      expect(() => compare.main(args.concat(["--redis-dir", path.join(d, "old-host")]))).toThrowError(/--app-dir/);
      expect(() => compare.main(args.concat(["--redis-dir", path.join(d, "old-host"), "--app-dir", path.join(d, "new-host")]))).not.toThrow();
      fs.rmSync(d, { recursive: true, force: true });
    });

    it("explains a missing argument or log directory", function () {
      expect(() => compare.main(["--baseline", "2026-10-07..2026-10-08"])).toThrowError(/required/);
      expect(() =>
        compare.main(["--data", path.join(dir, "nope"), "--baseline", "2026-10-07..2026-10-08", "--test", "2026-10-08..2026-10-09"])
      ).toThrowError(/no logs found/);
    });
  });

  describe("redis-sample.sh", function () {
    it("logs deltas, the BGSAVE count and compact latency events, with a stub redis-cli", function () {
      skipUnless("bash", "awk", "timeout", "mktemp", "tr");
      const dir = tmp();
      const bin = path.join(dir, "bin");
      const root = path.join(dir, "root");
      // A stand-in for redis6-cli that answers from files the test rewrites.
      write(
        path.join(bin, "cli"),
        `#!/bin/sh
case "$*" in
  INFO) cat "${dir}/info" ;;
  "SLOWLOG LEN") echo 3 ;;
  "SLOWLOG GET 1") printf '7\\n1700000000\\n12000\\nGET\\n' ;;
  "CONFIG GET latency-monitor-threshold") printf 'latency-monitor-threshold\\n100\\n' ;;
  "LATENCY LATEST") printf 'command\\n1700000000\\n150\\n220\\n' ;;
  *) exit 1 ;;
esac
`,
        0o755
      );
      const info = (n) =>
        [
          "uptime_in_seconds:" + (1000 + n * 60),
          "connected_clients:12",
          "rdb_bgsave_in_progress:0",
          "rdb_last_save_time:" + (1700000000 + (n > 0 ? 30 : 0)),
          "rdb_last_bgsave_status:ok",
          "rdb_last_bgsave_time_sec:31",
          "rdb_current_bgsave_time_sec:-1",
          "rdb_changes_since_last_save:55",
          "rdb_last_cow_size:1048576",
          "total_commands_processed:" + (1000 + n * 600),
          "total_net_input_bytes:" + (5000 + n * 6000),
          "total_net_output_bytes:" + (9000 + n * 12000),
          "total_connections_received:" + (10 + n * 2),
          "instantaneous_ops_per_sec:10",
          "latest_fork_usec:83000",
          "used_cpu_sys:" + (10 + n * 0.5).toFixed(6),
          "used_cpu_user:" + (20 + n * 1.5).toFixed(6),
          "used_cpu_sys_children:" + (5 + n * 2).toFixed(6),
          "used_cpu_user_children:" + (6 + n * 1).toFixed(6),
        ].join("\r\n") + "\r\n";
      const proc = (n) => {
        write(path.join(root, "proc/stat"), `cpu  0 0 0 0 0 0 0 0 0 0\ncpu0 ${600 * n} 0 ${200 * n} ${100 * n + 1} 0 ${50 * n} ${50 * n} 0 0 0\ncpu1 ${100 * n} 0 0 ${900 * n + 1} 0 0 0 0 0 0\n`);
        write(path.join(root, "proc/softirqs"), `CPU0 CPU1\nNET_TX: ${10 * n} ${n}\nNET_RX: ${100 * n} ${2 * n}\n`);
        write(path.join(root, "proc/pressure/cpu"), "some avg10=1.50 avg60=0.75 avg300=0.10 total=1\n");
        write(path.join(root, "proc/net/sockstat"), `TCP: inuse 5 orphan 0 tw 0 alloc 9 mem ${300 + n}\n`);
      };
      const env = Object.assign({}, process.env, { BLOT_ROOT: root, PERF_DIR: path.join(dir, "perf"), REDIS_CLI: path.join(bin, "cli") });
      const run = () => spawnSync("bash", [path.join(PERF, "redis-sample.sh")], { env, encoding: "utf8" });

      write(path.join(dir, "info"), info(0));
      proc(0);
      expect(run().status).toBe(0);
      write(path.join(dir, "info"), info(1));
      proc(1);
      expect(run().status).toBe(0);

      const lines = fs.readFileSync(path.join(dir, "perf/redis-sample.log"), "utf8").trim().split("\n");
      expect(lines.length).toBe(2);
      // first run has nothing to diff against: x, but never a broken line
      expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ dt=x cpu0_busy=x /);
      const f = Object.fromEntries(lines[1].split(" ").slice(1).map((kv) => kv.split("=")));
      // cpu0 over the interval: 600+200+50+50 busy jiffies of 1000 (1 idle)
      expect(parseFloat(f.cpu0_busy)).toBeCloseTo(90, 0);
      expect(f.cpu0_usr).toBe("60.0");
      expect(f.cpu0_sys).toBe("20.0");
      expect(f.cpu0_irq).toBe("5.0");
      expect(f.cpu0_si).toBe("5.0");
      expect(f.cpu1_busy).toBe("10.0");
      expect(f.netrx0).toBe("100");
      expect(f.nettx1).toBe("1");
      expect(f.psi10).toBe("1.50");
      expect(f.psi60).toBe("0.75");
      expect(f.tcpmem).toBe("301");
      expect(f.rcpu_sys).toBe("0.50");
      expect(f.rcpu_cusr).toBe("1.00");
      expect(f.cmds).toBe("600");
      expect(f.in_b).toBe("6000");
      expect(f.conns_new).toBe("2");
      expect(f.bgsaves).toBe("1");
      expect(f.bg_active).toBe("1");
      expect(f.bgsave_sec).toBe("31");
      expect(f.fork_us).toBe("83000");
      expect(f.slowlen).toBe("3");
      expect(f.slowid).toBe("7");
      expect(f.latmon).toBe("on");
      expect(f.lat).toBe("command:150/220@1700000000");

      // Redis down: still a line, with x for what Redis would have said
      write(path.join(bin, "cli"), "#!/bin/sh\nexit 1\n", 0o755);
      expect(run().status).toBe(0);
      const last = fs.readFileSync(path.join(dir, "perf/redis-sample.log"), "utf8").trim().split("\n").pop();
      expect(last).toMatch(/cmds=x .*clients=x /);
      expect(last).toContain("tcpmem=301");
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("latency-probe.py", function () {
    it("times PINGs and a pipelined burst against a fake Redis", async function () {
      skipUnless("python3");
      // Replies +PONG to every 14-byte PING frame, however the bytes are split.
      let pings = 0;
      const server = net.createServer((socket) => {
        let pending = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          pending = Buffer.concat([pending, chunk]);
          const frames = Math.floor(pending.length / 14);
          pending = pending.slice(frames * 14);
          pings += frames;
          socket.write("+PONG\r\n".repeat(frames));
        });
        socket.on("error", () => {});
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const dir = tmp();
      try {
        const out = await new Promise((resolve, reject) =>
          execFile(
            "python3",
            [path.join(PERF, "latency-probe.py"), "--label", "t", "--port", String(server.address().port), "--duration", "1", "--burst-bytes", "14000", "--log", "-"],
            { env: Object.assign({}, process.env, { PERF_DIR: dir }) },
            (err, stdout) => (err ? reject(err) : resolve(stdout))
          )
        );
        expect(out).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ label=t n=\d+ err=0 reconn=0 conn_ms=[\d.]+ p50=[\d.]+ p90=[\d.]+ p99=[\d.]+ p999=[\d.]+ max=[\d.]+ max_sec=\d+ gt10=\d+ gt50=\d+ gt100=\d+ gt1000=\d+ burst_ms=[\d.]+ burst_n=1000\n$/);
        expect(Number(/ n=(\d+)/.exec(out)[1])).toBeGreaterThan(5);
        expect(pings).toBeGreaterThan(1000); // the burst plus the pings
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("logs errors and x rather than failing when nothing is listening", async function () {
      skipUnless("python3");
      const dir = tmp();
      const out = await new Promise((resolve, reject) =>
        execFile(
          "python3",
          [path.join(PERF, "latency-probe.py"), "--label", "t", "--port", "1", "--duration", "1", "--log", "-"],
          { env: Object.assign({}, process.env, { PERF_DIR: dir }) },
          (err, stdout) => (err ? reject(err) : resolve(stdout))
        )
      );
      expect(out).toMatch(/ n=0 err=\d+ reconn=0 conn_ms=x p50=x .* max=x /);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("install.sh", function () {
    it("rejects a bad private IP before touching any host", function () {
      skipUnless("bash");
      const r = spawnSync("bash", [path.join(PERF, "install.sh"), "redis", "app", "not-an-ip"], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("IPv4");
    });
  });

  describe("fetch.sh", function () {
    it("writes app-lock.log only when docker answered for every container, and drops it with --no-app-logs", function () {
      skipUnless("bash", "tar", "awk", "sort", "grep", "ls");
      const dir = tmp();
      const stubs = path.join(dir, "stubs");
      const out = path.join(dir, "out");
      write(path.join(dir, "home/perf/redis-sample.log"), "2026-10-08T12:00:00Z dt=60\n");
      // ssh runs its command here, with the fake home; docker answers from the environment
      write(path.join(stubs, "ssh"), `#!/bin/sh\nwhile [ "$1" = -o ]; do shift 2; done\nshift\nexec sh -c "$*"\n`, 0o755);
      write(
        path.join(stubs, "docker"),
        `#!/bin/sh
case "$1" in
  inspect) [ "$MISSING" = "$2" ] && { echo "Error: No such object: $2" >&2; exit 1; }; exit 0 ;;
  logs) [ "$3" = --since ] && [ "$5" = blot-container-green ] && echo "2026-10-08T12:00:01.123Z [LOCK] slow heartbeat 900ms"; exit 0 ;;
esac
`,
        0o755
      );
      const env = Object.assign({}, process.env, { HOME: path.join(dir, "home"), FETCH_OUT: out, PATH: stubs + path.delimiter + process.env.PATH });
      const fetch = (extra) => spawnSync("bash", [path.join(PERF, "fetch.sh"), "redis-host", "app-host"], { env: Object.assign({}, env, extra), encoding: "utf8" });
      const lockLog = path.join(out, "app-host/app-lock.log");

      let r = fetch({});
      expect(r.status).toBe(0);
      expect(fs.readFileSync(lockLog, "utf8")).toBe("2026-10-08T12:00:00Z container=green slow=1 compromised=0\n");

      // a container docker cannot find: no (empty) app-lock.log for compare.js to read as zero lock lines
      r = fetch({ MISSING: "blot-container-yellow" });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("No such object: blot-container-yellow");
      expect(r.stderr).toContain("could not read the app container logs");
      expect(fs.existsSync(lockLog)).toBe(false);
      expect(fs.existsSync(lockLog + ".tmp")).toBe(false);

      // not fetching the app logs must not leave the counts of an earlier fetch
      expect(fetch({}).status).toBe(0);
      expect(fs.existsSync(lockLog)).toBe(true);
      r = spawnSync("bash", [path.join(PERF, "fetch.sh"), "--no-app-logs", "redis-host", "app-host"], { env, encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(fs.existsSync(lockLog)).toBe(false);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("cpu-squeeze.sh", function () {
    // A fake host: /proc and /sys under root, systemctl and taskset stand-ins on PATH.
    const squeezeHost = () => {
      const dir = tmp();
      const root = path.join(dir, "root");
      const stubs = path.join(dir, "stubs");
      // /proc and /sys of a 2-CPU host with an ENA card (names as on the real host)
      write(path.join(root, "proc/interrupts"), "       CPU0 CPU1\n 37: 1 2 ITS-MSI 1 Edge ena-mgmnt@pci:0000:00:05.0\n 38: 1 2 ITS-MSI 2 Edge ens5-Tx-Rx-0\n 39: 1 2 ITS-MSI 3 Edge ens5-Tx-Rx-1\n 40: 1 2 ITS-MSI 4 Edge nvme0q1\n");
      for (const irq of [37, 38, 39, 40]) write(path.join(root, `proc/irq/${irq}/smp_affinity`), "3\n");
      for (const q of [0, 1]) write(path.join(root, `sys/class/net/ens5/queues/rx-${q}/rps_cpus`), "0\n");
      write(path.join(root, "sys/class/net/lo/.keep"), "");
      write(path.join(root, "sys/devices/system/cpu/online"), "0-1\n");
      write(path.join(root, "proc/stat"), "cpu  1 0 1 1 0 0 0 0 0 0\ncpu0 1 0 1 1 0 0 0 0 0 0\ncpu1 1 0 1 1 0 0 0 0 0 0\n");
      write(path.join(root, "proc/softirqs"), "CPU0 CPU1\nNET_TX: 1 2\nNET_RX: 3 4\n");
      write(path.join(root, "proc/4242/comm"), "redis6-server\n");
      write(path.join(root, "proc/4242/task/4242/comm"), "redis6-server\n");
      // systemctl and taskset stand-ins: AllowedCPUs lives in files
      write(path.join(dir, "cpus/system.slice"), "0-1\n");
      write(path.join(dir, "cpus/user.slice"), "\n");
      write(path.join(dir, "cpus/init.scope"), "\n");
      write(
        path.join(stubs, "systemctl"),
        `#!/bin/sh
case "$1" in
  is-active) exit 3 ;;
  show) cat "${dir}/cpus/$5" 2> /dev/null; exit 0 ;;
  set-property) echo "\${4#AllowedCPUs=}" > "${dir}/cpus/$3" ;;
esac
`,
        0o755
      );
      write(path.join(stubs, "taskset"), `#!/bin/sh\necho "pid $2's current affinity list: 0"\n`, 0o755);
      const env = Object.assign({}, process.env, { BLOT_ROOT: root, BUSY_SECS: "0", PATH: stubs + path.delimiter + process.env.PATH });
      return {
        dir,
        root,
        stubs,
        env,
        state: path.join(root, "root/blot-cpu-squeeze.state"),
        run: (action) => spawnSync("bash", [path.join(PERF, "cpu-squeeze.sh"), "--local", action], { env, encoding: "utf8" }),
        read: (file) => fs.readFileSync(file, "utf8").trim(),
      };
    };

    it("saves state once, confines CPUs and IRQs, and restores them", function () {
      skipUnless("bash", "awk", "sort");
      const { dir, root, state, run, read } = squeezeHost();

      let r = run("on");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("+ systemctl set-property --runtime system.slice AllowedCPUs=0");
      expect(read(path.join(dir, "cpus/init.scope"))).toBe("0");
      expect(read(path.join(root, "proc/irq/38/smp_affinity"))).toBe("1");
      expect(read(path.join(root, "proc/irq/37/smp_affinity"))).toBe("1");
      expect(read(path.join(root, "proc/irq/40/smp_affinity"))).toBe("3"); // not the NIC's
      expect(read(path.join(root, "sys/class/net/ens5/queues/rx-1/rps_cpus"))).toBe("1");
      expect(read(state)).toContain("cpus system.slice 0-1");
      expect(r.stdout).toContain("4242/4242 redis6-server");

      // a second `on` keeps the original state instead of saving the squeezed one
      r = run("on");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("keeping those original values");
      expect(read(state)).toContain("irq 38 3");

      r = run("off");
      expect(r.status).toBe(0);
      expect(read(path.join(dir, "cpus/system.slice"))).toBe("0-1");
      expect(read(path.join(dir, "cpus/user.slice"))).toBe("0-1"); // was unset: all online CPUs
      expect(read(path.join(root, "proc/irq/38/smp_affinity"))).toBe("3");
      expect(read(path.join(root, "sys/class/net/ens5/queues/rx-0/rps_cpus"))).toBe("0");
      expect(fs.existsSync(state)).toBe(false);
      expect(run("off").stdout).toContain("nothing to restore");

      expect(run("bogus").status).not.toBe(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("does not trust state saved before a reboot", function () {
      skipUnless("bash", "awk", "sort");
      const { dir, root, state, run, read } = squeezeHost();
      const bootId = path.join(root, "proc/sys/kernel/random/boot_id");
      const stale = () => fs.readdirSync(path.dirname(state)).filter((f) => f.includes(".state.stale."));
      write(bootId, "boot-aaa\n");

      expect(run("on").status).toBe(0);
      expect(read(state)).toContain("boot boot-aaa");
      expect(run("on").stdout).toContain("keeping those original values"); // same boot

      // reboot: the masks and AllowedCPUs are back to normal, the state file is not
      write(bootId, "boot-bbb\n");
      for (const irq of [37, 38, 39]) write(path.join(root, `proc/irq/${irq}/smp_affinity`), "3\n");
      write(path.join(dir, "cpus/system.slice"), "0-1\n");
      expect(run("status").stdout).toContain("(stale)");

      // off restores nothing from it
      write(path.join(root, "proc/irq/38/smp_affinity"), "2\n");
      let r = run("off");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("already undid the squeeze");
      expect(r.stdout).toContain("== redis6-server threads"); // verified
      expect(read(path.join(root, "proc/irq/38/smp_affinity"))).toBe("2");
      expect(r.stdout).not.toContain("+ systemctl set-property");
      expect(fs.existsSync(state)).toBe(false);
      expect(stale().length).toBe(1);

      // on takes new state instead of keeping the old
      write(path.join(root, "proc/irq/38/smp_affinity"), "3\n");
      expect(run("on").status).toBe(0);
      write(bootId, "boot-ccc\n");
      for (const irq of [37, 38, 39]) write(path.join(root, `proc/irq/${irq}/smp_affinity`), "2\n");
      r = run("on");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("rebooted since");
      expect(read(state)).toContain("boot boot-ccc");
      expect(read(state)).toContain("irq 38 2");
      expect(read(path.join(root, "proc/irq/38/smp_affinity"))).toBe("1");

      // a state file with no boot id (not written by this script) counts as stale too
      fs.writeFileSync(state, "nic ens5\nirq 38 3\n");
      r = run("off");
      expect(r.stdout).toContain("already undid the squeeze");
      expect(stale().length).toBe(3);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("stops at the first failing command when run over ssh, as --local does", function () {
      skipUnless("bash", "awk", "sort");
      const { dir, stubs, env, run } = squeezeHost();
      // ssh runs its command here instead, under a sudo that does nothing, with the script on stdin
      write(path.join(stubs, "ssh"), `#!/bin/sh\nwhile [ "$1" = -o ]; do shift 2; done\nshift\nexec sh -c "$*"\n`, 0o755);
      write(path.join(stubs, "sudo"), `#!/bin/sh\nexec "$@"\n`, 0o755);
      const viaSsh = (action) => spawnSync("bash", [path.join(PERF, "cpu-squeeze.sh"), "somehost", action], { env, encoding: "utf8" });

      const ok = viaSsh("on");
      expect(ok.stderr).toBe("");
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("== redis6-server threads");
      expect(viaSsh("off").status).toBe(0);

      // systemctl set-property fails: no verification afterwards and a nonzero exit
      write(path.join(stubs, "systemctl"), `#!/bin/sh\ncase "$1" in is-active) exit 3 ;; set-property) exit 1 ;; esac\n`, 0o755);
      for (const go of [viaSsh, run]) {
        const r = go("on");
        expect(r.status).not.toBe(0);
        expect(r.stdout).toContain("+ systemctl set-property");
        expect(r.stdout).not.toContain("== redis6-server threads");
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("refuses to run while irqbalance is active", function () {
      skipUnless("bash", "awk", "sort");
      const dir = tmp();
      const stubs = path.join(dir, "stubs");
      write(path.join(stubs, "systemctl"), "#!/bin/sh\nexit 0\n", 0o755); // is-active succeeds
      write(path.join(dir, "root/proc/interrupts"), "x\n");
      const env = Object.assign({}, process.env, { BLOT_ROOT: path.join(dir, "root"), PATH: stubs + path.delimiter + process.env.PATH });
      const r = spawnSync("bash", [path.join(PERF, "cpu-squeeze.sh"), "--local", "on"], { env, encoding: "utf8" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("irqbalance is active");
      expect(fs.existsSync(path.join(dir, "root/root/blot-cpu-squeeze.state"))).toBe(false);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
