// Extra coverage for proxy/config/cacher.lua beyond the ported basic/gzip/
// inspect/lru_purge/rehydrate suites. Uses inspect.conf because it wires up
// every endpoint the cacher exposes (/purge, /inspect, /).
const fetch = require("node-fetch");
const setup = require("./util/setup");

describe("cacher coverage", function () {
  setup("./inspect.conf");

  it("keeps a separate cache entry per host and purges only the named host", async function () {
    const hitA = await fetch(this.origin + "/timestamp/x", { headers: { Host: "a.example" } });
    const hitB = await fetch(this.origin + "/timestamp/x", { headers: { Host: "b.example" } });
    expect(hitA.headers.get("Cache-Status")).toBe("MISS");
    expect(hitB.headers.get("Cache-Status")).toBe("MISS");

    expect((await this.listCache()).length).toBe(2);

    // both are now cached
    for (const host of ["a.example", "b.example"]) {
      const res = await fetch(this.origin + "/timestamp/x", { headers: { Host: host } });
      expect(res.headers.get("Cache-Status")).toBe("HIT");
    }

    const purge = await fetch(this.origin + "/purge?host=a.example");
    expect(purge.status).toBe(200);
    expect((await purge.text()).trim()).toBe("a.example: 1");

    // a.example missed again, b.example still cached
    const afterA = await fetch(this.origin + "/timestamp/x", { headers: { Host: "a.example" } });
    const afterB = await fetch(this.origin + "/timestamp/x", { headers: { Host: "b.example" } });
    expect(afterA.headers.get("Cache-Status")).toBe("MISS");
    expect(afterB.headers.get("Cache-Status")).toBe("HIT");
  });

  it("does not cache POST requests", async function () {
    const res = await fetch(this.origin + "/timestamp/post", { method: "POST" });
    expect(res.status).toBe(200);
    // a non-cacheable method leaves $upstream_cache_status empty
    expect(res.headers.get("Cache-Status") || "").not.toBe("MISS");
    expect(await this.listCache({ watch: false })).toEqual([]);
  });

  it("does not cache the health check", async function () {
    await fetch(this.origin + "/health");
    const again = await fetch(this.origin + "/health");
    expect(again.status).toBe(200);
    expect(again.headers.get("Cache-Status") || "").not.toBe("HIT");
    expect(await this.listCache({ watch: false })).toEqual([]);
  });

  it("stores binary response bodies intact across MISS and HIT", async function () {
    const miss = await fetch(this.origin + "/logo.png");
    expect(miss.headers.get("Cache-Status")).toBe("MISS");
    expect(miss.headers.get("Content-Type")).toBe("image/png");
    const missBody = Buffer.from(await miss.arrayBuffer());

    const hit = await fetch(this.origin + "/logo.png");
    expect(hit.headers.get("Cache-Status")).toBe("HIT");
    const hitBody = Buffer.from(await hit.arrayBuffer());

    expect(hitBody.length).toBe(missBody.length);
    expect(Buffer.compare(hitBody, missBody)).toBe(0);
  });

  it("asks for a host when /purge is called without one", async function () {
    const res = await fetch(this.origin + "/purge");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("please pass host to purge");
  });

  it("asks for a host when /inspect is called without one", async function () {
    const res = await fetch(this.origin + "/inspect");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("please pass host to inspect");
  });

  it("inspect returns nothing for a host with no cached entries", async function () {
    const res = await fetch(this.origin + "/inspect?host=nobody.example");
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("");
  });
});
