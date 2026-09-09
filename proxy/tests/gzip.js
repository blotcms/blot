const fs = require("fs-extra");
const fetch = require("node-fetch");
const setup = require("./util/setup");
const zlib = require("zlib");

describe("cacher handles gzip", function () {
  setup("./gzip.conf");

  // I think this test reproduces a bug on our server where we have multiple files
  // seemingly with the same cache key but different md5 hash filenames
  // https://github.com/openresty/srcache-nginx-module/issues/11
  // nginx claims it will use the md5 hash of the key to determine the filename
  // but it seems that if there is a gzipped and non-gzipped version of the file
  // it will produce a different md5 hash
  it("does not store multiple cache files when the accept-encoded header is different", async function () {
    const response = await fetch(this.origin + "/gzip", {
      headers: { "Accept-Encoding": "" }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Encoding")).toBe(null);
    expect(response.headers.get("Cache-Status")).toBe("MISS");

    const text = await response.text();

    expect((await this.listCache()).length).toEqual(1);

    const compressedResponse = await fetch(this.origin + "/gzip", {
      headers: { "Accept-Encoding": "gzip" }
    });
    expect(compressedResponse.status).toBe(200);
    expect(compressedResponse.headers.get("Content-Encoding")).toBe("gzip");
    expect(compressedResponse.headers.get("Cache-Status")).toBe("HIT");
    expect(await compressedResponse.text()).toBe(text);

    expect((await this.listCache()).length).toEqual(1);

    // try with the accept-encoding header set to internet explorer 6
    const ie6Response = await fetch(this.origin + "/gzip", {
      headers: { "Accept-Encoding": "gzip, deflate" }
    });
    expect(ie6Response.status).toBe(200);
    expect(ie6Response.headers.get("Cache-Status")).toBe("HIT");
    expect(await ie6Response.text()).toBe(text);

    expect((await this.listCache()).length).toEqual(1);

    const purgeResponse = await fetch(this.origin + "/purge?host=127.0.0.1");
    const purgeText = await purgeResponse.text();
    expect(purgeResponse.status).toBe(200);
    expect(purgeText.trim()).toBe("127.0.0.1: 1");

    expect(await this.listCache({ watch: false })).toEqual([]);
  });
});
