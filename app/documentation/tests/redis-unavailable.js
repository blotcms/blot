describe("documentation when redis is unavailable", function () {
  const config = require("config");
  const client = require("models/client");
  const { ClientOfflineError } = require("redis");

  global.test.site();
  global.test.timeout(5 * 60 * 1000);

  // The proxy caches 400s for a year but never 503s, so an outage must
  // never surface as a 400 on the documentation.
  it("responds 503, not a cacheable 400, when a route cannot reach redis", async function () {
    const spy = spyOn(client, "get").and.callFake(() =>
      Promise.reject(new ClientOfflineError())
    );

    let res, body;

    try {
      res = await this.fetch(
        config.protocol + config.host + "/news/confirm/abc"
      );
      body = await res.text();
    } finally {
      // afterEach hooks (removeUser) need a working client
      spy.and.callThrough();
    }

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("Temporarily unavailable");
  });
});
