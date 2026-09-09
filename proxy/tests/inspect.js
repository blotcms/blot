const fs = require("fs-extra");
const fetch = require("node-fetch");
const setup = require("./util/setup");

describe("cacher", function () {
  setup("./inspect.conf");

  it(
    "inspects stored requests",
    async function () {
      const number_of_requests = 100;

      for (let i = 0; i < number_of_requests; i++) {
        const res = await fetch(this.origin + "/timestamp/" + i);
        const text = await res.text();
        expect(res.status).toBe(200);
        expect(parseInt(text)).toBeGreaterThan(0);
        expect(res.headers.get("Cache-Status")).toBe("MISS");
      }

      const files = await this.listCache();

      expect(files.length).toBe(number_of_requests);

      const inspectResponse = await fetch(
        this.origin + "/inspect?host=127.0.0.1"
      );
      const inspectText = await inspectResponse.text();

      expect(inspectText.trim().split("\n").sort()).toEqual(
        files.map(path => path.split("/").pop()).sort()
      );

      expect(await this.inspectCache()).toEqual("Cache is consistent");
    },
    1000 * 60 * 5
  );
});
