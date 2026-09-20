describe("onedrive classifyError", function () {
  const { classify, issueFromAccount, SOURCES } = require("../util/classifyError");
  const health = require("clients/health");

  function error(status, code) {
    const err = new Error("x");
    err.status = status;
    err.code = code;
    return err;
  }

  it("treats 401s and invalid_grant as reauth, stored as 401", function () {
    expect(classify(error(401), SOURCES.APPLY)).toEqual(
      jasmine.objectContaining({ persist: true, healthCode: health.CODES.REAUTH_REQUIRED, status: 401 })
    );
    expect(classify(error(400, "invalid_grant"), SOURCES.AUTH)).toEqual(
      jasmine.objectContaining({ persist: true, healthCode: health.CODES.REAUTH_REQUIRED, status: 401 })
    );
  });

  it("treats 507 as storage full", function () {
    expect(classify(error(507, "quotaLimitReached"), SOURCES.APPLY)).toEqual(
      jasmine.objectContaining({ persist: true, healthCode: health.CODES.QUOTA_EXCEEDED, status: 507 })
    );
  });

  it("only treats a 404 as a missing folder when looking up the folder", function () {
    expect(classify(error(404), SOURCES.FOLDER).healthCode).toBe(
      health.CODES.SOURCE_MISSING
    );
    expect(classify(error(404), SOURCES.APPLY).persist).toBe(false);
  });

  it("ignores transient failures and aborts", function () {
    expect(classify(error(429), SOURCES.APPLY).persist).toBe(false);
    expect(classify(error(503), SOURCES.APPLY).persist).toBe(false);
    expect(classify(new Error("network"), SOURCES.APPLY).persist).toBe(false);

    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classify(abort, SOURCES.APPLY).persist).toBe(false);
  });

  it("maps a stored account to a health issue", function () {
    expect(issueFromAccount(null)).toBe(null);
    expect(issueFromAccount({ error_code: 0 })).toBe(null);
    expect(issueFromAccount({ error_code: 500 })).toBe(null);
    expect(issueFromAccount({ error_code: 401, error_since: 5 })).toEqual({
      code: "REAUTH_REQUIRED",
      since: 5,
    });
    expect(issueFromAccount({ error_code: 404 }).code).toBe("SOURCE_MISSING");
    expect(issueFromAccount({ error_code: 507 }).code).toBe("QUOTA_EXCEEDED");
  });
});
