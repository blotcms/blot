const config = require("config");
const withEntryFields = require("../../../lib/withEntryFields");

describe("lib/withEntryFields", function () {
  let previousFlag;

  beforeEach(function () {
    previousFlag = config.redis.readEntriesFromHash;
  });

  afterEach(function () {
    config.redis.readEntriesFromHash = previousFlag;
  });

  it("passes the narrow fetch straight through when hash reads are off", async function () {
    config.redis.readEntriesFromHash = false;

    let fullCalled = false;

    const result = await withEntryFields(
      async () => [{ title: "{{summary}}" }],
      async () => {
        fullCalled = true;
        return "full";
      }
    );

    expect(fullCalled).toBe(false);
    expect(result).toEqual([{ title: "{{summary}}" }]);
  });

  it("returns the narrow result unchanged when no entry has Mustache", async function () {
    config.redis.readEntriesFromHash = true;

    let fullCalled = false;

    const result = await withEntryFields(
      async () => [{ title: "Plain" }, { title: "Also plain" }],
      async () => {
        fullCalled = true;
        return "full";
      }
    );

    expect(fullCalled).toBe(false);
    expect(result.length).toBe(2);
  });

  it("refetches in full when a narrowed entry carries Mustache", async function () {
    config.redis.readEntriesFromHash = true;

    const result = await withEntryFields(
      async () => [
        { title: "Plain" },
        { title: "{{#allEntries}}{{summary}}{{/allEntries}}" },
      ],
      async () => "full entries"
    );

    expect(result).toEqual("full entries");
  });

  it("handles a single entry (not an array) from the narrow fetch", async function () {
    config.redis.readEntriesFromHash = true;

    const result = await withEntryFields(
      async () => ({ title: "{{foo}}" }),
      async () => "full"
    );

    expect(result).toEqual("full");
  });
});
