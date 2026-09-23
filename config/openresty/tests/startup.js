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

    const cachedUrl = this.origin + "/timestamp/cold-0";
    const before = await fetch(cachedUrl);
    const beforeBody = await before.text();
    expect(before.headers.get("Cache-Status")).toBe("HIT");

    await this.restartOpenresty({ waitForIndex: false });

    let saw503 = false;
    let checkedHit = false;
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

        if (!checkedHit) {
          const hit = await fetch(cachedUrl);
          expect(hit.status).toBe(200);
          expect(hit.headers.get("Cache-Status")).toBe("HIT");
          expect(await hit.text()).toBe(beforeBody);

          const inspect = await fetch(this.origin + "/inspect?host=127.0.0.1");
          expect(inspect.status).toBe(503);
          expect((await inspect.text()).trim()).toContain("not ready");
          checkedHit = true;
        }
      } else if (purge.status === 200) {
        body = (await purge.text()).trim();
        break;
      } else {
        throw new Error("unexpected purge status " + purge.status);
      }
    }

    expect(saw503).toBe(true);
    expect(checkedHit).toBe(true);
    expect(body).toBe("127.0.0.1: " + count);
    expect(await this.listCache({ watch: false })).toEqual([]);

    const miss = await fetch(cachedUrl);
    expect(miss.status).toBe(200);
    expect(miss.headers.get("Cache-Status")).toBe("MISS");
    expect(await miss.text()).not.toBe(beforeBody);
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

    const cachedUrl = this.origin + "/timestamp/reload-0";
    const hit = await fetch(cachedUrl);
    const hitBody = await hit.text();
    expect(hit.headers.get("Cache-Status")).toBe("HIT");

    const purge = await fetch(this.origin + "/purge?host=127.0.0.1");
    expect(purge.status).toBe(200);
    expect((await purge.text()).trim()).toBe("127.0.0.1: " + count);
    expect(await this.listCache({ watch: false })).toEqual([]);

    const miss = await fetch(cachedUrl);
    expect(miss.headers.get("Cache-Status")).toBe("MISS");
    expect(await miss.text()).not.toBe(hitBody);
  }, 60000);

  it("rebuilds the index when a reload recreates the shared dictionary", async function () {
    const cachedUrl = this.origin + "/timestamp/resize";
    const first = await fetch(cachedUrl);
    const body = await first.text();
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Status")).toBe("MISS");

    const confPath = path.join(path.dirname(this.cache_directory), "startup.conf");
    const conf = await fs.readFile(confPath, "utf8");
    expect(conf).toContain("lua_shared_dict cacher_dictionary 50m;");
    await fs.writeFile(
      confPath,
      conf.replace(
        "lua_shared_dict cacher_dictionary 50m;",
        "lua_shared_dict cacher_dictionary 51m;"
      )
    );

    const logPath = path.join(path.dirname(this.cache_directory), "error.log");
    const before = (await fs.readFile(logPath, "utf8")).length;
    await this.signalOpenresty("HUP");

    // The previous worker can still answer /purge from the old dictionary
    // until it exits. Wait until the new worker has rebuilt the emptied one.
    let added = "";
    const reloadDeadline = Date.now() + 15000;
    while (Date.now() < reloadDeadline) {
      added = (await fs.readFile(logPath, "utf8")).slice(before);
      if (added.includes("source=walk")) break;
      await sleep(20);
    }
    expect(added).toContain("walking cache directory");
    expect(added).toContain("source=walk");
    expect(added).toContain("entries=1");

    const hit = await fetch(cachedUrl);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("Cache-Status")).toBe("HIT");
    expect(await hit.text()).toBe(body);

    const purge = await fetch(this.origin + "/purge?host=127.0.0.1");
    expect(purge.status).toBe(200);
    expect((await purge.text()).trim()).toBe("127.0.0.1: 1");
    expect(await this.listCache({ watch: false })).toEqual([]);

    const miss = await fetch(cachedUrl);
    expect(miss.headers.get("Cache-Status")).toBe("MISS");
    expect(await miss.text()).not.toBe(body);
  }, 60000);
});

describe("cacher snapshot", function () {
  setup("./basic.conf");

  function readyLines(log) {
    return log.split("\n").filter((line) => line.includes("cacher: index ready"));
  }

  it("purges from a clean-shutdown snapshot without walking the cache", async function () {
    const cachedUrl = this.origin + "/timestamp/snap";
    const res = await fetch(cachedUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Status")).toBe("MISS");
    const body = await res.text();

    await this.restartOpenresty({ graceful: true });

    const hit = await fetch(cachedUrl);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("Cache-Status")).toBe("HIT");
    expect(await hit.text()).toBe(body);

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

    const miss = await fetch(cachedUrl);
    expect(miss.headers.get("Cache-Status")).toBe("MISS");
    expect(await miss.text()).not.toBe(body);
  }, 30000);

  it("walks the disk after an unclean shutdown instead of trusting a stale snapshot", async function () {
    const bodies = {};
    for (const url of ["/timestamp/a", "/timestamp/b"]) {
      const res = await fetch(this.origin + url);
      expect(res.headers.get("Cache-Status")).toBe("MISS");
      bodies[url] = await res.text();
    }

    await this.restartOpenresty({ graceful: true });

    const third = await fetch(this.origin + "/timestamp/c");
    expect(third.headers.get("Cache-Status")).toBe("MISS");
    bodies["/timestamp/c"] = await third.text();

    await this.restartOpenresty();

    const hit = await fetch(this.origin + "/timestamp/c");
    expect(hit.headers.get("Cache-Status")).toBe("HIT");
    expect(await hit.text()).toBe(bodies["/timestamp/c"]);

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

    const miss = await fetch(this.origin + "/timestamp/a");
    expect(miss.headers.get("Cache-Status")).toBe("MISS");
    expect(await miss.text()).not.toBe(bodies["/timestamp/a"]);
  }, 30000);
});
