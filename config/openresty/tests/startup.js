const child_process = require("child_process");
const crypto = require("crypto");
const fs = require("fs-extra");
const fetch = require("node-fetch");
const setup = require("./util/setup");

// cacher.lua rebuilds its purge index from the cache directory in the
// background, so nginx serves straight away and /purge answers 503 until the
// index is complete.
describe("cacher startup", function () {
  setup("./basic.conf");

  // Enough entries that the walk is still running when the first requests
  // arrive after a restart
  const number_of_files = 20000;

  // Fill the cache directory with entries in the layout nginx uses
  // (levels=1:2, named by the md5 of the key)
  const fillCache = async (cache_directory, origin) => {
    const batch_size = 500;

    for (let start = 0; start < number_of_files; start += batch_size) {
      const writes = [];

      for (let i = start; i < start + batch_size; i++) {
        const key = `${origin}/filler/${i}`;
        const hash = crypto.createHash("md5").update(key).digest("hex");
        writes.push(
          fs.outputFile(
            `${cache_directory}/${hash.slice(-1)}/${hash.slice(-3, -1)}/${hash}`,
            `\nKEY: ${key}\n`
          )
        );
      }

      await Promise.all(writes);
    }
  };

  const workerPids = () =>
    child_process
      .execSync("ps -eo pid,args | grep '[w]orker process' | awk '{print $1}'")
      .toString()
      .trim()
      .split("\n")
      .sort();

  it(
    "serves and caches while the index is rebuilt, then purges everything",
    async function () {
      const first = await fetch(this.origin + "/timestamp/cached");
      const cachedText = await first.text();
      expect(first.headers.get("Cache-Status")).toBe("MISS");

      await fillCache(this.cache_directory, this.origin);

      const offset = await this.logSize();

      await this.restartOpenresty({ waitForIndex: false });

      // the index is still being rebuilt
      const early = await fetch(this.origin + "/purge?host=127.0.0.1");
      expect(early.status).toBe(503);
      expect(early.headers.get("Retry-After")).toBe("30");

      // cached responses are served meanwhile
      const hit = await fetch(this.origin + "/timestamp/cached");
      expect(hit.headers.get("Cache-Status")).toBe("HIT");
      expect(await hit.text()).toBe(cachedText);

      // a miss during the walk is still purged once the index is complete
      const miss = await fetch(this.origin + "/timestamp/during");
      expect(miss.headers.get("Cache-Status")).toBe("MISS");

      await this.waitForIndex(offset);

      const purge = await fetch(this.origin + "/purge?host=127.0.0.1");
      expect(purge.status).toBe(200);
      expect((await purge.text()).trim()).toBe(
        `127.0.0.1: ${number_of_files + 2}`
      );

      expect(await this.listCache({ watch: false })).toEqual([]);
    },
    1000 * 60 * 5
  );

  it("keeps the index across a reload without walking the cache", async function () {
    const res = await fetch(this.origin + "/timestamp/reload");
    expect(res.headers.get("Cache-Status")).toBe("MISS");

    const offset = await this.logSize();
    const workersBefore = workerPids();

    await this.reloadOpenresty();

    // wait for the new workers to replace the old ones
    const deadline = Date.now() + 10 * 1000;
    let workersAfter = workerPids();
    while (workersAfter.some((pid) => workersBefore.includes(pid))) {
      if (Date.now() > deadline) throw new Error("workers were not replaced");
      await new Promise((resolve) => setTimeout(resolve, 50));
      workersAfter = workerPids();
    }

    const log = (await fs.readFile(this.cache_directory + "/../error.log"))
      .subarray(offset)
      .toString();

    expect(log).not.toContain("rehydrate:");

    const purge = await fetch(this.origin + "/purge?host=127.0.0.1");
    expect(purge.status).toBe(200);
    expect((await purge.text()).trim()).toBe("127.0.0.1: 1");
  });
});
