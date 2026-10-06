const fetch = require("node-fetch");
const setup = require("./util/setup");

// The token is read from the environment of the openresty process, which
// setup() starts in beforeEach, so it must be set before that runs.
describe("cacher purge authorization", function () {
  const TOKEN = "purge-test-token";
  let previous;

  beforeAll(function () {
    previous = process.env.BLOT_PURGE_TOKEN;
    process.env.BLOT_PURGE_TOKEN = TOKEN;
  });

  afterAll(function () {
    if (previous === undefined) delete process.env.BLOT_PURGE_TOKEN;
    else process.env.BLOT_PURGE_TOKEN = previous;
  });

  setup("./purge_auth.conf");

  it("rejects a purge without the token", async function () {
    const res = await fetch(this.origin + "/purge?host=example.com");
    expect(res.status).toBe(403);
  });

  it("rejects a purge with the wrong token", async function () {
    const res = await fetch(this.origin + "/purge?host=example.com", {
      headers: { "X-Blot-Purge-Token": "wrong-token-xxx" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a token of a different length", async function () {
    const res = await fetch(this.origin + "/purge?host=example.com", {
      headers: { "X-Blot-Purge-Token": TOKEN + "x" },
    });
    expect(res.status).toBe(403);
  });

  it("accepts a purge with the token", async function () {
    const res = await fetch(this.origin + "/purge?host=example.com", {
      headers: { "X-Blot-Purge-Token": TOKEN },
    });
    expect(res.status).toBe(200);
  });
});

describe("cacher purge without a token configured", function () {
  let previous;

  beforeAll(function () {
    previous = process.env.BLOT_PURGE_TOKEN;
    delete process.env.BLOT_PURGE_TOKEN;
  });

  afterAll(function () {
    if (previous !== undefined) process.env.BLOT_PURGE_TOKEN = previous;
  });

  setup("./purge_auth.conf");

  it("allows a purge without a token", async function () {
    const res = await fetch(this.origin + "/purge?host=example.com");
    expect(res.status).toBe(200);
  });
});
