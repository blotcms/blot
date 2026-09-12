const fs = require("fs-extra");
const fetch = require("node-fetch");
const setup = require("./util/setup");

describe("cacher", function () {
  setup("./basic.conf");

  it("caches a request", async function () {
    const response = await fetch(this.origin);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Status")).toBe("MISS");
    expect(text).toBe("Hello Node!");

    const files = await this.listCache();

    expect(files.length).toBe(1);

    const buffer = await fs.readFile(files[0]);
    // The file starts with nginx's fixed-size binary cache header
    // (ngx_http_file_cache_header_t). Its raw bytes include a timestamp, so
    // it occasionally contains a '\n' (0x0A) byte, which used to shift every
    // line index below and made this spec flaky. Slice from the "KEY: "
    // marker so we only split the guaranteed plain-text metadata/headers/
    // body into lines.
    const keyIndex = buffer.indexOf("KEY: ");
    const contents = buffer.slice(keyIndex).toString("utf-8");
    // we trim because the lines end with '\r'
    const lines = contents.split("\n").map(l => l.trim());

    expect(lines.length).toBe(11);
    expect(lines[0]).toBe("KEY: " + this.origin + "/");
    expect(lines[1]).toBe("HTTP/1.1 200 OK");
    expect(lines[2]).toBe("X-Powered-By: Express");
    expect(lines[3]).toBe("Content-Type: text/html; charset=utf-8");
    expect(lines[4]).toBe("Content-Length: 11");
    expect(lines[5]).toMatch(/^ETag: /);
    expect(lines[6]).toMatch(/^Date: /);
    expect(lines[7]).toBe("Connection: keep-alive");
    expect(lines[8]).toBe("Keep-Alive: timeout=5");

    expect(lines[10]).toBe("Hello Node!");

    // if we retry the request, the header 'cache-hit' should be set
    const cachedResponse = await fetch(this.origin);
    const cachedText = await cachedResponse.text();
    expect(cachedResponse.status).toBe(200);
    expect(cachedResponse.headers.get("Cache-Status")).toBe("HIT");
    expect(cachedText).toBe(text);
  });

  it("purges a cached request", async function () {
    const response = await fetch(this.origin);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Status")).toBe("MISS");
    const cachedResponse = await fetch(this.origin);
    const cachedText = await cachedResponse.text();
    expect(cachedResponse.status).toBe(200);
    expect(cachedResponse.headers.get("Cache-Status")).toBe("HIT");
    expect(cachedText).toBe(text);
    // use a request to origin/purge with method PURGE and query host '127.0.0.1' to purge the cache
    await fetch(this.origin + "/purge?host=127.0.0.1");
    const purgedResponse = await fetch(this.origin);
    const purgedText = await purgedResponse.text();
    expect(purgedResponse.status).toBe(200);
    expect(purgedResponse.headers.get("Cache-Status")).toBe("MISS");
    expect(purgedText).toBe(text);
  });

  it("purges a cached request even after restarting openresty", async function () {
    const response = await fetch(this.origin);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Status")).toBe("MISS");

    await this.restartOpenresty();

    expect((await this.listCache()).length).toEqual(1);

    const purgeResponse = await fetch(this.origin + "/purge?host=127.0.0.1");
    const purgeText = await purgeResponse.text();
    expect(purgeResponse.status).toBe(200);
    expect(purgeText.trim()).toBe("127.0.0.1: 1");

    expect(await this.listCache({ watch: false })).toEqual([]);
  });

  it("can purge multiple hosts", async function () {
    const purgeResponse = await fetch(this.origin + "/purge?host=example1.com&host=example2.com");
    const purgeText = await purgeResponse.text();

    expect(purgeResponse.status).toBe(200);
    expect(purgeText.trim()).toBe("example1.com: 0\nexample2.com: 0");
  });

  it("purges a large number of cached requests", async function () {
    const number_of_requests = 500;

    for (let i = 0; i < number_of_requests; i++) {
      const res = await fetch(this.origin + "/timestamp/" + i);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(parseInt(text)).toBeGreaterThan(0);
      expect(res.headers.get("Cache-Status")).toBe("MISS");
    }

    expect((await this.listCache()).length).toEqual(number_of_requests);

    const purgeResponse = await fetch(this.origin + "/purge?host=127.0.0.1");
    const purgeText = await purgeResponse.text();
    expect(purgeResponse.status).toBe(200);
    expect(purgeText.trim()).toBe("127.0.0.1: " + number_of_requests);
  });
});
