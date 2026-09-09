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
});
