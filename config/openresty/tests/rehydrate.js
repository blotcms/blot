const crypto = require("crypto");
const fs = require("fs-extra");
const fetch = require("node-fetch");
const setup = require("./util/setup");

describe("cacher", function () {
  setup("./rehydrate.conf");

  it("tells us when there's an invalid cache file", async function () {
    const number_of_requests = 100;

    for (let i = 0; i < number_of_requests; i++) {
      const res = await fetch(this.origin + "/timestamp/" + i);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(parseInt(text)).toBeGreaterThan(0);
      expect(res.headers.get("Cache-Status")).toBe("MISS");
    }
    // now we insert a cache files into the cache directory
    // that are invalid
    await fs.outputFile(
      this.cache_directory + "/i/nv/no-key",
      "invalid",
      "utf8"
    );

    // now we insert a cache files into the cache directory
    // that are invalid
    await fs.outputFile(
      this.cache_directory + "/i/nv/empty-key",
      `KEY: 
       ...`,
      "utf8"
    );

    // add a file containing 100 random bytes
    await fs.outputFile(
      this.cache_directory + "/i/nv/random-bytes",
      new Array(100)
        .fill(0)
        .map(() => Math.random())
        .join(""),
      "utf8"
    );

    // add an empty file
    await fs.outputFile(this.cache_directory + "/i/nv/empty", "", "utf8");

    const rehydrateResponse = await fetch(this.origin + "/rehydrate");
    const rehydrateText = await rehydrateResponse.text();

    expect(rehydrateText.trim().split("\n")).toEqual([
      "i/nv/empty",
      "i/nv/empty-key",
      "i/nv/no-key",
      "i/nv/random-bytes"
    ]);
  });

  it(
    "tells us when rehydration is successful",
    async function () {
      const number_of_requests = 100;

      for (let i = 0; i < number_of_requests; i++) {
        const res = await fetch(this.origin + "/timestamp/" + i);
        const text = await res.text();
        expect(res.status).toBe(200);
        expect(parseInt(text)).toBeGreaterThan(0);
        expect(res.headers.get("Cache-Status")).toBe("MISS");
      }

      const rehydrateResponse = await fetch(this.origin + "/rehydrate");
      const rehydrateText = await rehydrateResponse.text();

      expect(rehydrateText.trim()).toEqual("OK");

      const files = await this.listCache();

      expect(files.length).toBe(number_of_requests);

      const inspectResponse = await fetch(
        this.origin + "/inspect?host=127.0.0.1"
      );
      const inspectText = await inspectResponse.text();

      expect(inspectText.trim().split("\n").sort()).toEqual(
        files.map(path => path.split("/").pop()).sort()
      );

      // checks for mismatches
      expect(await this.inspectCache()).toEqual("Cache is consistent");
    },
    1000 * 60 * 5
  );

  it("keeps refusing purges when the cache directory cannot be listed", async function () {
    await fs.remove(this.cache_directory);

    const rehydrateResponse = await fetch(this.origin + "/rehydrate");
    expect(rehydrateResponse.status).toBe(500);
    expect(await rehydrateResponse.text()).toContain("rehydrate failed: find exit");

    // an incomplete index must not be used to report a purge as done
    const purgeResponse = await fetch(this.origin + "/purge?host=127.0.0.1");
    expect(purgeResponse.status).toBe(503);
  });

  it("keeps refusing purges when the index does not fit in the dictionary", async function () {
    // far more entries than rehydrate.conf's 300k cacher_dictionary holds
    const writes = [];
    for (let i = 0; i < 10000; i++) {
      const key = `${this.origin}/filler/${i}`;
      const hash = crypto.createHash("md5").update(key).digest("hex");
      writes.push(
        fs.outputFile(
          `${this.cache_directory}/${hash.slice(-1)}/${hash.slice(-3, -1)}/${hash}`,
          `\nKEY: ${key}\n`
        )
      );
    }
    await Promise.all(writes);

    const rehydrateResponse = await fetch(this.origin + "/rehydrate");
    expect(rehydrateResponse.status).toBe(500);
    expect(await rehydrateResponse.text()).toContain("could not add to index");

    const purgeResponse = await fetch(this.origin + "/purge?host=127.0.0.1");
    expect(purgeResponse.status).toBe(503);
  });

  it("stops accepting purges when a cache miss cannot be indexed", async function () {
    // rehydrate.conf's 300k cacher_dictionary holds a few thousand entries
    let status = 200;

    for (let batch = 0; batch < 200 && status === 200; batch++) {
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          fetch(`${this.origin}/timestamp/${batch}-${i}`).then((res) => res.text())
        )
      );
      status = (await fetch(this.origin + "/purge?host=nothing.example")).status;
    }

    // the index is missing a cached file, so a purge could not remove it
    expect(status).toBe(503);
  }, 1000 * 60 * 5);
});
