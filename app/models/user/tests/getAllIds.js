var client = require("models/client");
var key = require("../key");
var getAllIds = require("../getAllIds");

describe("user getAllIds", function () {
  var testUids = ["user_getall_001", "user_getall_002", "user_getall_003"];

  beforeEach(async function () {
    for (var i = 0; i < testUids.length; i++) {
      await client.sAdd(key.uids, testUids[i]);
    }
  });

  afterEach(async function () {
    for (var i = 0; i < testUids.length; i++) {
      await client.sRem(key.uids, testUids[i]);
    }
  });

  it("returns an array", async function () {
    var ids = await getAllIds();
    expect(Array.isArray(ids)).toBe(true);
  });

  it("returns all user IDs from the set", async function () {
    var ids = await getAllIds();
    for (var i = 0; i < testUids.length; i++) {
      expect(ids).toContain(testUids[i]);
    }
  });

  it("returns empty array when no users exist", async function () {
    for (var i = 0; i < testUids.length; i++) {
      await client.sRem(key.uids, testUids[i]);
    }
    var ids = await getAllIds();
    expect(ids).toEqual([]);
  });

  it("handles adding and removing users", async function () {
    var newUid = "user_getall_new";
    await client.sAdd(key.uids, newUid);

    var ids = await getAllIds();
    expect(ids).toContain(newUid);

    await client.sRem(key.uids, newUid);

    ids = await getAllIds();
    expect(ids).not.toContain(newUid);
  });
});
