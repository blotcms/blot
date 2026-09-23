const fs = require("fs-extra");
const fetch = require("node-fetch");
const path = require("path");
const setup = require("./util/setup");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("cacher startup", function () {
  setup("./startup.conf");

  async function fill(origin, count, prefix) {
    for (let i = 0; i < count; i++) {
      const res = await fetch(origin + "/timestamp/" + prefix + i);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Status")).toBe("MISS");
    }
  }

  it("serves while a cold rebuild is in progress and does not purge early", async function () {
    const count = 96;
    await fill(this.origin, count, "cold-");
    expect((await this.listCache()).length).toBe(count);

    await this.restartOpenresty({ waitForIndex: false });

    let saw503 = false;
    let body = null;
    const deadline = Date.now() + 20000;

    while (Date.now() < deadline) {
      const health = await fetch(this.origin + "/health", { timeout: 1000 });
      expect(health.status).toBe(200);

      const purge = await fetch(this.origin + "/purge?host=127.0.0.1", {
        timeout: 1000,
      });

      if (purge.status === 503) {
        saw503 = true;
        expect((await purge.text()).trim()).toContain("not ready");
        expect((await this.listCache({ watch: false })).length).toBe(count);
      } else if (purge.status === 200) {
        body = (await purge.text()).trim();
        break;
      } else {
        throw new Error("unexpected purge status " + purge.status);
      }
    }

    expect(saw503).toBe(true);
    expect(body).toBe("127.0.0.1: " + count);
    expect(await this.listCache({ watch: false })).toEqual([]);
  }, 60000);

  it("does not rebuild the index on reload", async function () {
    const count = 40;
    await fill(this.origin, count, "reload-");

    const logPath = path.join(path.dirname(this.cache_directory), "error.log");
    const before = (await fs.readFile(logPath, "utf8")).length;
    await this.signalOpenresty("HUP");

    let added = "";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      added = (await fs.readFile(logPath, "utf8")).slice(before);
      if (
        added.includes("skipping rebuild") ||
        added.includes("walking cache directory")
      ) {
        break;
      }
      await sleep(20);
    }

    expect(added).toContain("index already ready, skipping rebuild");
    expect(added).not.toContain("walking cache directory");

    const purge = await fetch(this.origin + "/purge?host=127.0.0.1");
    expect(purge.status).toBe(200);
    expect((await purge.text()).trim()).toBe("127.0.0.1: " + count);
    expect(await this.listCache({ watch: false })).toEqual([]);
  }, 60000);
});

describe("cacher snapshot", function () {
  setup("./basic.conf");

  function readyLines(log) {
    return log.split("\n").filter((line) => line.includes("cacher: index ready"));
  }

  it("purges from a clean-shutdown snapshot without walking the cache", async function () {
    const res = await fetch(this.origin + "/timestamp/snap");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Status")).toBe("MISS");

    await this.restartOpenresty({ graceful: true });

    const log = await fs.readFile(
      path.join(path.dirname(this.cache_directory), "error.log"),
      "utf8"
    );
    const ready = readyLines(log);
    expect(ready[ready.length - 1]).toContain("source=snapshot");
    expect(ready[ready.length - 1]).toContain("entries=1");

    const indexDir = path.join(path.dirname(this.cache_directory), "cacher-index");
    const indexMode = (await fs.stat(indexDir)).mode & 0o777;
    expect(indexMode).toBe(0o700);

    const purge = await fetch(this.origin + "/purge?host=127.0.0.1");
    expect(purge.status).toBe(200);
    expect((await purge.text()).trim()).toBe("127.0.0.1: 1");
    expect(await this.listCache({ watch: false })).toEqual([]);
  }, 30000);

  it("walks the disk after an unclean shutdown instead of trusting a stale snapshot", async function () {
    for (const url of ["/timestamp/a", "/timestamp/b"]) {
      const res = await fetch(this.origin + url);
      expect(res.headers.get("Cache-Status")).toBe("MISS");
    }

    await this.restartOpenresty({ graceful: true });

    const third = await fetch(this.origin + "/timestamp/c");
    expect(third.headers.get("Cache-Status")).toBe("MISS");

    await this.restartOpenresty();

    const log = await fs.readFile(
      path.join(path.dirname(this.cache_directory), "error.log"),
      "utf8"
    );
    const ready = readyLines(log);
    expect(ready[ready.length - 1]).toContain("source=walk");
    expect(ready[ready.length - 1]).toContain("entries=3");

    const purge = await fetch(this.origin + "/purge?host=127.0.0.1");
    expect(purge.status).toBe(200);
    expect((await purge.text()).trim()).toBe("127.0.0.1: 3");
    expect(await this.listCache({ watch: false })).toEqual([]);
  }, 30000);
});
