const fs = require("fs");
const path = require("path");

// redis.conf is production configuration, so pin the settings that were chosen
// on purpose. (host/setup.sh proves the file parses with a real redis6-server.)
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

// { directive: [value, ...] } - a directive can repeat, e.g. "save"
const parse = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .reduce((config, line) => {
      const [name, ...value] = line.split(/\s+/);
      (config[name] = config[name] || []).push(value.join(" "));
      return config;
    }, {});

describe("redis.conf", function () {
  const config = parse(read("redis.conf"));
  const only = (name) =>
    config[name] && config[name].length === 1 ? config[name][0] : config[name];

  it("persists with RDB at most every five minutes", function () {
    expect(config.save).toEqual(["3600 1", "300 100"]);
    expect(only("appendonly")).toBe("no");
    expect(only("stop-writes-on-bgsave-error")).toBe("yes");
  });

  it("errors on writes at maxmemory instead of evicting", function () {
    expect(only("maxmemory-policy")).toBe("noeviction");
    // maxmemory itself is derived from RAM by host/setup.sh
    expect(config.maxmemory).toBeUndefined();
    expect(config.include).toEqual(["/etc/redis6/blot-memory.conf"]);
  });

  it("sizes connections and replication for a large dataset", function () {
    expect(only("tcp-backlog")).toBe("1024");
    expect(only("tcp-keepalive")).toBe("60");
    expect(only("maxclients")).toBe("10000");
    expect(only("repl-backlog-size")).toBe("256mb");
    expect(config["client-output-buffer-limit"]).toEqual([
      "replica 1gb 512mb 120",
    ]);
    expect(only("repl-diskless-sync")).toBe("no");
  });

  it("frees memory lazily and avoids huge pages", function () {
    [
      "lazyfree-lazy-eviction",
      "lazyfree-lazy-expire",
      "lazyfree-lazy-server-del",
      "lazyfree-lazy-user-del",
      "replica-lazy-flush",
      "disable-thp",
    ].forEach((name) => expect(only(name)).toBe("yes"));
  });

  it("stays consistent with the host settings", function () {
    const setup = read("host/setup.sh");
    expect(setup).toContain("net.core.somaxconn = 4096");
    expect(setup).toContain("LimitNOFILE=65536");
    expect(setup).not.toContain("tcp_mem =");
    expect(setup).toContain("/etc/ssh/sshd_config.d/10-blot.conf");
    expect(setup).toContain("PasswordAuthentication no");
    expect(setup).toContain("KbdInteractiveAuthentication no");
    expect(setup).toContain("PermitRootLogin no");
  });
});
