const health = require("clients/health");
const {
  MESSAGES,
  TREE_REJECTED,
  isMissingRepoError,
  isTreeRejectedError,
  issueFromSyncError,
  healthAction,
} = require("../error");

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

  it("classifies a rejected tree by its code with a specific message", function () {
    const err = new Error("some other wording");
    err.code = TREE_REJECTED;

    expect(isTreeRejectedError(err)).toBe(true);
    expect(issueFromSyncError(err)).toEqual({
      code: health.CODES.SYNC_ERROR,
      message: MESSAGES.TREE_REJECTED,
    });
    expect(MESSAGES.TREE_REJECTED).toContain("symbolic links or submodules");
  });

  it("does not classify a rejected tree from prose alone", function () {
    const err = new Error(
      "Git blogs support regular files only (no symbolic links or submodules)"
    );

    expect(isTreeRejectedError(err)).toBe(false);
    expect(issueFromSyncError(err).message).toBe(
      health.ISSUES.SYNC_ERROR.message
    );
  });

  it("never shows raw git output for other failures", function () {
    const err = new Error(
      "fatal: unable to access '/data/git/example.git/': permission denied"
    );

    expect(issueFromSyncError(err)).toEqual({
      code: health.CODES.SYNC_ERROR,
      message: health.ISSUES.SYNC_ERROR.message,
    });
    expect(issueFromSyncError(new Error(""))).toEqual({
      code: health.CODES.SYNC_ERROR,
      message: health.ISSUES.SYNC_ERROR.message,
    });
    expect(issueFromSyncError("No commit on repository").message).toBe(
      health.ISSUES.SYNC_ERROR.message
    );
  });
});

describe("git health actions", function () {
  const base = "/sites/example/client/git";

  it("sends REAUTH_REQUIRED to reset the password", function () {
    expect(healthAction(health.CODES.REAUTH_REQUIRED, false, base)).toEqual({
      action: "Reset password",
      actionUrl: base + "/reset-password",
    });
  });

  it("sends SOURCE_MISSING to disconnect so Git can be set up again", function () {
    expect(healthAction(health.CODES.SOURCE_MISSING, false, base)).toEqual({
      action: "Reconnect",
      actionUrl: base + "/disconnect",
    });
  });

  it("sends a failed create back to /create", function () {
    expect(healthAction(health.CODES.SYNC_ERROR, true, base).actionUrl).toBe(
      base + "/create"
    );
  });

  it("shows no button for a push failure", function () {
    expect(healthAction(health.CODES.SYNC_ERROR, false, base)).toEqual({
      action: undefined,
      actionUrl: undefined,
    });
  });

  it("leaves codes Git never reports on the defaults", function () {
    expect(healthAction(health.CODES.QUOTA_EXCEEDED, false, base)).toBe(null);
  });
});
