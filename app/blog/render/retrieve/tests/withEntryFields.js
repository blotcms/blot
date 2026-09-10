var config = require("config");
var withEntryFields = require("../helpers/withEntryFields");

describe("retrieve/withEntryFields", function () {
  var previousFlag;

  beforeEach(function () {
    previousFlag = config.redis.readEntriesFromHash;
  });

  afterEach(function () {
    config.redis.readEntriesFromHash = previousFlag;
  });

  it("passes the narrow fetch straight through when hash reads are off", function (done) {
    config.redis.readEntriesFromHash = false;

    var fullCalled = false;

    withEntryFields(
      function (cb) {
        cb([{ title: "{{summary}}" }]); // Mustache present, but flag is off
      },
      function (cb) {
        fullCalled = true;
        cb("full");
      },
      function (result) {
        expect(fullCalled).toBe(false);
        expect(result).toEqual([{ title: "{{summary}}" }]);
        done();
      }
    );
  });

  it("returns the narrow result unchanged when no entry has Mustache", function (done) {
    config.redis.readEntriesFromHash = true;

    var fullCalled = false;

    withEntryFields(
      function (cb) {
        cb([{ title: "Plain" }, { title: "Also plain" }]);
      },
      function (cb) {
        fullCalled = true;
        cb("full");
      },
      function (result) {
        expect(fullCalled).toBe(false);
        expect(result.length).toBe(2);
        done();
      }
    );
  });

  it("refetches in full when a narrowed entry carries Mustache", function (done) {
    config.redis.readEntriesFromHash = true;

    withEntryFields(
      function (cb) {
        cb([
          { title: "Plain" },
          { title: "{{#allEntries}}{{summary}}{{/allEntries}}" },
        ]);
      },
      function (cb) {
        cb("full entries");
      },
      function (result) {
        expect(result).toEqual("full entries");
        done();
      }
    );
  });

  it("handles a single entry (not an array) from the narrow fetch", function (done) {
    config.redis.readEntriesFromHash = true;

    withEntryFields(
      function (cb) {
        cb({ title: "{{foo}}" });
      },
      function (cb) {
        cb("full");
      },
      function (result) {
        expect(result).toEqual("full");
        done();
      }
    );
  });
});
