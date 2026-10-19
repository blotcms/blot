const fetch = require("node-fetch");
const setup = require("./util/setup");

describe("ban", function () {
  setup("./ban.conf");

  // The client IP is whatever X-Real-IP says (see ban.conf), so each spec
  // uses its own public address. Loopback and private addresses are never banned.
  const get = (origin, path, ip) =>
    fetch(origin + path, { headers: { "X-Real-IP": ip } }).then(
      (res) => res.status,
      () => "closed"
    );

  it("bans an IP after three 444s", async function () {
    const ip = "203.0.113.1";

    expect(await get(this.origin, "/", ip)).toBe(200);
    expect(await get(this.origin, "/scan", ip)).toBe("closed");
    expect(await get(this.origin, "/scan", ip)).toBe("closed");
    expect(await get(this.origin, "/", ip)).toBe(200);
    expect(await get(this.origin, "/scan", ip)).toBe("closed");

    expect(await get(this.origin, "/", ip)).toBe("closed");
    expect(await get(this.origin, "/", "203.0.113.2")).toBe(200);
  });

  it("never bans a whitelisted IP", async function () {
    const ip = "203.0.113.50";

    for (let i = 0; i < 5; i++) await get(this.origin, "/scan", ip);

    expect(await get(this.origin, "/", ip)).toBe(200);
  });

  it("never bans private addresses", async function () {
    for (const ip of ["10.1.2.3", "192.168.1.5", "172.20.0.2", "127.0.0.2"]) {
      for (let i = 0; i < 5; i++) await get(this.origin, "/scan", ip);

      expect(await get(this.origin, "/", ip)).toBe(200);
    }
  });
});
