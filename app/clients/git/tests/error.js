const health = require("clients/health");
const { MESSAGES, isMissingRepoError, issueFromSyncError } = require("../error");

describe("git health error helpers", function () {
  it("classifies a missing live repo as SOURCE_MISSING", function () {
    const err = new Error(
      [
        "Git repo does not exist in blog folder for /tmp/blog_x",
        "- Path to git: /workspace",
      ].join("\n")
    );

    expect(isMissingRepoError(err)).toBe(true);
    expect(issueFromSyncError(err)).toEqual({
      code: health.CODES.SOURCE_MISSING,
      message: MESSAGES.SOURCE_MISSING,
    });
  });

  it("classifies other git failures as SYNC_ERROR with the original message", function () {
    expect(issueFromSyncError(new Error("No commit on repository"))).toEqual({
      code: health.CODES.SYNC_ERROR,
      message: "No commit on repository",
    });
  });

  it("uses the shared SYNC_ERROR copy when the error has no message", function () {
    expect(issueFromSyncError(new Error(""))).toEqual({
      code: health.CODES.SYNC_ERROR,
      message: health.ISSUES.SYNC_ERROR.message,
    });
  });
});
