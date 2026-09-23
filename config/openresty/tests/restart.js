const fs = require("fs-extra");
const fetch = require("node-fetch");
const path = require("path");
const setup = require("./util/setup");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("cacher with several workers", function () {
  setup("./restart.conf");

  async function put(origin, host, urlPath) {
    const res = await fetch(origin + urlPath, { headers: { Host: host } });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Status")).toBe("MISS");
    return body;
  }

  async function expectHit(origin, host, urlPath, body) {
    const res = await fetch(origin + urlPath, { headers: { Host: host } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Status")).toBe("HIT");
    expect(await res.text()).toBe(body);
  }

  it("serves hits and purges one host after reload and a clean restart", async function () {
    const origin = this.origin;
    const alpha = await put(origin, "alpha.example", "/timestamp/a");
    const alpha2 = await put(origin, "alpha.example", "/timestamp/a2");
    const beta = await put(origin, "beta.example", "/timestamp/b");
    const beta2 = await put(origin, "beta.example", "/timestamp/b2");
    const beta3 = await put(origin, "beta.example", "/timestamp/b3");

    const logPath = path.join(path.dirname(this.cache_directory), "error.log");
    const beforeReload = (await fs.readFile(logPath, "utf8")).length;
    await this.signalOpenresty("HUP");

    let reloaded = "";
    const reloadDeadline = Date.now() + 5000;
    while (Date.now() < reloadDeadline) {
      reloaded = (await fs.readFile(logPath, "utf8")).slice(beforeReload);
      if (reloaded.includes("skipping rebuild")) break;
      await sleep(20);
    }
    expect(reloaded).toContain("index already ready, skipping rebuild");
    expect(reloaded).not.toContain("walking cache directory");

    await expectHit(origin, "alpha.example", "/timestamp/a", alpha);
    await expectHit(origin, "beta.example", "/timestamp/b3", beta3);

    await this.restartOpenresty({ graceful: true });

    const log = await fs.readFile(logPath, "utf8");
    const ready = log.split("\n").filter((line) => line.includes("cacher: index ready"));
    expect(ready[ready.length - 1]).toContain("source=snapshot");
    expect(ready[ready.length - 1]).toContain("entries=5");

    await expectHit(origin, "alpha.example", "/timestamp/a2", alpha2);
    await expectHit(origin, "beta.example", "/timestamp/b", beta);
    await expectHit(origin, "beta.example", "/timestamp/b2", beta2);

    const purge = await fetch(origin + "/purge?host=alpha.example");
    expect(purge.status).toBe(200);
    expect((await purge.text()).trim()).toBe("alpha.example: 2");

    expect((await this.listCache({ watch: false })).length).toBe(3);

    const alphaMiss = await fetch(origin + "/timestamp/a", {
      headers: { Host: "alpha.example" },
    });
    expect(alphaMiss.headers.get("Cache-Status")).toBe("MISS");
    expect(await alphaMiss.text()).not.toBe(alpha);

    await expectHit(origin, "beta.example", "/timestamp/b", beta);
    await expectHit(origin, "beta.example", "/timestamp/b2", beta2);
    await expectHit(origin, "beta.example", "/timestamp/b3", beta3);
  }, 60000);
});
