const { parseFileStatus } = require("../recent-activity");

describe("recent activity", function () {
  it("reads file operations from sync status messages", function () {
    expect(parseFileStatus("Syncing /posts/a.txt")).toEqual({
      verb: "synced",
      path: "/posts/a.txt",
    });
    expect(parseFileStatus("(2/5) Removing /old.md")).toEqual({
      verb: "removed",
      path: "/old.md",
    });
    expect(parseFileStatus("Downloading /img/photo.jpg").verb).toEqual("downloaded");
    expect(parseFileStatus("Transferring /img/photo.jpg").verb).toEqual("transferred");
  });

  it("ignores messages that are not file operations", function () {
    expect(parseFileStatus("Rebuilding /Templates/local/entry.html")).toBe(null);
    expect(parseFileStatus("Removing Dropbox credentials")).toBe(null);
    expect(parseFileStatus("Syncing /")).toEqual({ verb: "synced", path: "/" });
    expect(parseFileStatus("")).toBe(null);
    expect(parseFileStatus(undefined)).toBe(null);
  });
});
