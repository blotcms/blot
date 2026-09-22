const health = require("../health");

describe("client health", function () {
  it("builds ok and syncing states with no issues", function () {
    expect(health.ok()).toEqual({ state: "ok", issues: [] });
    expect(health.syncing()).toEqual({ state: "syncing", issues: [] });
  });

  it("fills in default copy for an issue", function () {
    const result = health.error([{ code: health.CODES.REAUTH_REQUIRED }]);

    expect(result.state).toBe("error");
    expect(result.issues).toEqual([
      {
        code: "REAUTH_REQUIRED",
        message: health.ISSUES.REAUTH_REQUIRED.message,
      },
    ]);
  });

  it("keeps a client-supplied message and since", function () {
    const result = health.error([
      { code: "SYNC_ERROR", message: "Transfer failed", since: 1758000000000 },
    ]);

    expect(result.issues[0]).toEqual({
      code: "SYNC_ERROR",
      message: "Transfer failed",
      since: 1758000000000,
    });
  });

  it("orders issues most severe first", function () {
    const result = health.error([
      { code: "SYNC_ERROR" },
      { code: "SOURCE_MISSING" },
      { code: "UNAVAILABLE" },
      { code: "REAUTH_REQUIRED" },
    ]);

    expect(
      result.issues.map(function (item) {
        return item.code;
      })
    ).toEqual(["UNAVAILABLE", "REAUTH_REQUIRED", "SOURCE_MISSING", "SYNC_ERROR"]);
    expect(health.primaryIssue(result).code).toBe("UNAVAILABLE");
  });

  it("returns ok rather than an empty error", function () {
    expect(health.error([])).toEqual(health.ok());
    expect(health.error()).toEqual(health.ok());
  });

  it("rejects unknown codes and invalid timestamps", function () {
    expect(function () {
      health.issue("NOPE");
    }).toThrow();
    expect(function () {
      health.issue("SYNC_ERROR", { since: "yesterday" });
    }).toThrow();
  });

  it("has a short label for every code", function () {
    Object.keys(health.CODES).forEach(function (code) {
      expect(typeof health.label(code)).toBe("string");
    });
    expect(health.label("NOPE")).toBeUndefined();
  });

  it("has no primary issue for a healthy client", function () {
    expect(health.primaryIssue(health.ok())).toBeUndefined();
  });
});
