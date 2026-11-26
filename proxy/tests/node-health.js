const http = require("http");
const fetch = require("node-fetch");
const setup = require("./util/setup");

// Routing around a blocked node-a (config/node_health.lua). Two stubs stand
// in for this unit's node-a and the other unit's. A "blocked" stub never
// answers /health, as a node-a whose event loop is stuck doesn't; it still
// answers other requests, so a response shows which stub served it.
describe("node health", function () {
  const stubs = {};

  function stub(name, port) {
    const state = { blocked: false };
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        if (state.blocked) return; // never answers
        return res.end("OK");
      }
      res.end(name);
    });
    return new Promise((resolve) =>
      server.listen(port, "127.0.0.1", () => {
        stubs[name] = state;
        resolve({
          close: () =>
            new Promise((done) => {
              server.closeAllConnections();
              server.close(done);
            }),
        });
      })
    );
  }

  setup("./node-health.conf", {
    upstream: async ({ port }) => {
      const local = await stub("local", port);
      const peer = await stub("peer", port + 1);
      return {
        close: () => Promise.all([local.close(), peer.close()]),
      };
    },
  });

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const served = async (origin) => (await fetch(origin + "/page")).text();

  it("sends requests to this unit's node-a while it answers", async function () {
    await wait(1000);
    expect(await served(this.origin)).toBe("local");
  });

  it("sends requests to the other unit's node-a while this one is blocked, and back once it answers", async function () {
    stubs.local.blocked = true;
    await wait(1500);
    expect(await served(this.origin)).toBe("peer");

    stubs.local.blocked = false;
    await wait(1000);
    expect(await served(this.origin)).toBe("local");
  });

  it("routes as usual when both are blocked", async function () {
    stubs.local.blocked = true;
    stubs.peer.blocked = true;
    await wait(1500);
    expect(await served(this.origin)).toBe("local");
  });
});
