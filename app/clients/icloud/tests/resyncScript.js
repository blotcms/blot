// scripts/icloud/resync.js must skip the blogs the client's hourly validation
// skips, so running it can't remove files from a blog whose folder is gone.
describe("scripts/icloud/resync skipReason", function () {
  const getHealthPath = require.resolve("../getHealth");
  const scriptPath = require.resolve("../../../../scripts/icloud/resync");
  let original;
  let health;
  let skipReason;

  beforeEach(function () {
    original = require.cache[getHealthPath];
    health = { issues: [] };
    require.cache[getHealthPath] = {
      id: getHealthPath,
      filename: getHealthPath,
      loaded: true,
      exports: async () => health,
    };
    delete require.cache[scriptPath];
    skipReason = require(scriptPath).skipReason;
  });

  afterEach(function () {
    delete require.cache[scriptPath];
    if (original) require.cache[getHealthPath] = original;
    else delete require.cache[getHealthPath];
  });

  it("resyncs a set up account without problems", async function () {
    expect(await skipReason("blog_1", { setupComplete: true })).toBe(null);
  });

  it("skips a missing account, incomplete setup, a transfer or a stored error", async function () {
    expect(await skipReason("blog_1", null)).toEqual(jasmine.any(String));
    expect(await skipReason("blog_1", { setupComplete: false })).toEqual(
      jasmine.any(String)
    );
    expect(
      await skipReason("blog_1", {
        setupComplete: true,
        transferringToiCloud: true,
      })
    ).toEqual(jasmine.any(String));
    expect(
      await skipReason("blog_1", { setupComplete: true, error: "gone" })
    ).toEqual(jasmine.any(String));
  });

  it("skips a blog with a problem on the customer's side", async function () {
    const { CODES } = require("clients/health");
    health = { issues: [{ code: CODES.SOURCE_MISSING }] };
    expect(await skipReason("blog_1", { setupComplete: true })).toEqual(
      jasmine.any(String)
    );
  });
});
