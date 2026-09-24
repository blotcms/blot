const health = require("clients/health");
const {
  BLOG_DIRECTORY_DELETED,
  classifyError,
  resolveIssue,
  normalizeErrorFields,
  shouldSkipBackgroundSync,
  isSetupInProgress,
  backfillFields,
} = require("../error");

describe("icloud error classification", function () {
  it("maps the deleted-folder sentinel to SOURCE_MISSING", function () {
    expect(classifyError(BLOG_DIRECTORY_DELETED)).toBe(
      health.CODES.SOURCE_MISSING
    );
  });

  it("maps any other message to SYNC_ERROR", function () {
    expect(classifyError("Invalid sharing link")).toBe(health.CODES.SYNC_ERROR);
    expect(classifyError("")).toBe(health.CODES.SYNC_ERROR);
  });

  it("prefers a stored errorCode over the message", function () {
    const issue = resolveIssue({
      error: BLOG_DIRECTORY_DELETED,
      errorCode: health.CODES.SYNC_ERROR,
      errorSince: 100,
    });

    expect(issue.code).toBe(health.CODES.SYNC_ERROR);
    expect(issue.message).toBe(BLOG_DIRECTORY_DELETED);
    expect(issue.since).toBe(100);
  });

  it("uses the shared SOURCE_MISSING copy instead of the sentinel", function () {
    const issue = resolveIssue({
      error: BLOG_DIRECTORY_DELETED,
      errorCode: health.CODES.SOURCE_MISSING,
    });

    expect(issue).toEqual({ code: health.CODES.SOURCE_MISSING });
  });

  it("returns null when there is no stored error", function () {
    expect(resolveIssue(null)).toBeNull();
    expect(resolveIssue({})).toBeNull();
    expect(resolveIssue({ error: null, errorCode: null })).toBeNull();
  });

  it("classifies a legacy free-text error without a code", function () {
    expect(resolveIssue({ error: BLOG_DIRECTORY_DELETED }).code).toBe(
      health.CODES.SOURCE_MISSING
    );
    expect(resolveIssue({ error: "Transfer failed" })).toEqual({
      code: health.CODES.SYNC_ERROR,
      message: "Transfer failed",
    });
  });

  it("clears codes when error is null", function () {
    expect(normalizeErrorFields({ error: null }, { error: "x" })).toEqual({
      error: null,
      errorCode: null,
      errorSince: null,
    });
  });

  it("preserves errorSince when the same issue is rewritten", function () {
    const current = {
      error: "Transfer failed",
      errorCode: health.CODES.SYNC_ERROR,
      errorSince: 123,
    };

    expect(
      normalizeErrorFields({ error: "Transfer failed again" }, current)
    ).toEqual({
      error: "Transfer failed again",
      errorCode: health.CODES.SYNC_ERROR,
      errorSince: 123,
    });
  });

  it("stamps errorSince when a new issue appears", function () {
    const before = Date.now();
    const result = normalizeErrorFields(
      { error: BLOG_DIRECTORY_DELETED, errorCode: health.CODES.SOURCE_MISSING },
      { error: null }
    );
    const after = Date.now();

    expect(result.errorCode).toBe(health.CODES.SOURCE_MISSING);
    expect(result.errorSince).toBeGreaterThanOrEqual(before);
    expect(result.errorSince).toBeLessThanOrEqual(after);
  });

  it("skips background sync for incomplete setup, errors, and transfers", function () {
    expect(shouldSkipBackgroundSync(null)).toBe(true);
    expect(shouldSkipBackgroundSync({ setupComplete: true })).toBe(false);
    expect(
      shouldSkipBackgroundSync({ setupComplete: true, error: "nope" })
    ).toBe(true);
    expect(
      shouldSkipBackgroundSync({
        setupComplete: true,
        transferringToiCloud: true,
      })
    ).toBe(true);
    expect(shouldSkipBackgroundSync({ setupComplete: false })).toBe(true);
  });

  it("treats an accepted sharing link as setup in progress", function () {
    expect(
      isSetupInProgress({
        setupComplete: false,
        sharingLink: "https://www.icloud.com/iclouddrive/abc",
      })
    ).toBe(true);
    expect(
      isSetupInProgress({
        setupComplete: false,
        sharingLink: "https://www.icloud.com/iclouddrive/abc",
        error: "Invalid sharing link",
      })
    ).toBe(false);
    expect(isSetupInProgress({ setupComplete: true })).toBe(false);
    expect(
      isSetupInProgress({ setupComplete: true, transferringToiCloud: true })
    ).toBe(true);
  });

  it("builds backfill fields only when a code or since is missing", function () {
    expect(backfillFields({ error: BLOG_DIRECTORY_DELETED })).toEqual(
      jasmine.objectContaining({
        error: BLOG_DIRECTORY_DELETED,
        errorCode: health.CODES.SOURCE_MISSING,
      })
    );
    expect(
      backfillFields({
        error: "x",
        errorCode: health.CODES.SYNC_ERROR,
        errorSince: 1,
      })
    ).toBeNull();
    expect(backfillFields({ setupComplete: true })).toBeNull();
  });
});
