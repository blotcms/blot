const health = require("clients/health");
const {
  BLOG_DIRECTORY_DELETED,
  SETUP_FAILED,
  classify,
  resolveCode,
  resolveIssue,
  isSetupError,
  normalizeErrorFields,
  shouldSkipBackgroundSync,
  isSetupInProgress,
} = require("../error");

describe("icloud error classification", function () {
  it("prefers a stored errorCode over the message", function () {
    expect(
      classify({
        error: BLOG_DIRECTORY_DELETED,
        errorCode: health.CODES.TRANSFER_INCOMPLETE,
      })
    ).toBe(health.CODES.TRANSFER_INCOMPLETE);
  });

  it("ignores unknown errorCode values", function () {
    expect(
      classify({ error: BLOG_DIRECTORY_DELETED, errorCode: "NOPE" })
    ).toBeNull();
  });

  it("does not treat setup failures as sync health", function () {
    const account = {
      error: "Invalid sharing link",
      errorCode: SETUP_FAILED,
      setupComplete: false,
    };

    expect(resolveCode(account)).toBe(SETUP_FAILED);
    expect(isSetupError(account)).toBe(true);
    expect(classify(account)).toBeNull();
    expect(resolveIssue(account)).toBeNull();
  });

  it("builds an issue with the shared message and errorSince", function () {
    expect(
      resolveIssue({
        error: "Request failed after 3 retries: http://macserver/upload",
        errorCode: health.CODES.TRANSFER_INCOMPLETE,
        errorSince: 100,
      })
    ).toEqual({ code: health.CODES.TRANSFER_INCOMPLETE, since: 100 });
  });

  it("returns null when there is no stored error", function () {
    expect(resolveIssue(null)).toBeNull();
    expect(resolveIssue({})).toBeNull();
    expect(resolveIssue({ error: null, errorCode: null })).toBeNull();
    expect(isSetupError(null)).toBe(false);
    expect(isSetupError({ error: null, errorCode: null })).toBe(false);
  });

  it("treats a leftover errorCode with no error as no error", function () {
    // an older process during a deploy can clear only `error`
    const account = {
      setupComplete: true,
      error: null,
      errorCode: health.CODES.SOURCE_MISSING,
      errorSince: 100,
    };

    expect(resolveCode(account)).toBeNull();
    expect(classify(account)).toBeNull();
    expect(resolveIssue(account)).toBeNull();
    expect(isSetupError({ error: "", errorCode: SETUP_FAILED })).toBe(false);
  });

  it("clears every error field when error is null", function () {
    expect(normalizeErrorFields({ error: null }, { error: "x" })).toEqual({
      error: null,
      errorCode: null,
      errorSince: null,
    });
  });

  it("uses a code written at the source", function () {
    expect(
      normalizeErrorFields(
        { error: "Boom", errorCode: health.CODES.TRANSFER_INCOMPLETE },
        { setupComplete: false }
      ).errorCode
    ).toBe(health.CODES.TRANSFER_INCOMPLETE);
    expect(
      normalizeErrorFields(
        { error: "Invalid sharing link", errorCode: SETUP_FAILED },
        null
      ).errorCode
    ).toBe(SETUP_FAILED);
  });

  it("infers a code from the merged row when a writer sends none", function () {
    expect(
      normalizeErrorFields(
        { error: BLOG_DIRECTORY_DELETED },
        { setupComplete: true }
      ).errorCode
    ).toBe(health.CODES.SOURCE_MISSING);
    expect(
      normalizeErrorFields(
        { acceptedSharingLink: false, error: "Invalid sharing link" },
        { setupComplete: false }
      ).errorCode
    ).toBe(SETUP_FAILED);
    expect(
      normalizeErrorFields(
        { error: "Boom" },
        { setupComplete: false, acceptedSharingLink: true }
      ).errorCode
    ).toBe(health.CODES.TRANSFER_INCOMPLETE);
  });

  it("preserves errorSince when the same code is written again", function () {
    const current = {
      setupComplete: true,
      error: BLOG_DIRECTORY_DELETED,
      errorCode: health.CODES.SOURCE_MISSING,
      errorSince: 123,
    };

    expect(
      normalizeErrorFields(
        {
          error: BLOG_DIRECTORY_DELETED,
          errorCode: health.CODES.SOURCE_MISSING,
        },
        current
      )
    ).toEqual({
      error: BLOG_DIRECTORY_DELETED,
      errorCode: health.CODES.SOURCE_MISSING,
      errorSince: 123,
    });
  });

  it("resets errorSince when the code changes or the error was clear", function () {
    const before = Date.now();
    const changed = normalizeErrorFields(
      { error: "Boom", errorCode: health.CODES.TRANSFER_INCOMPLETE },
      {
        error: BLOG_DIRECTORY_DELETED,
        errorCode: health.CODES.SOURCE_MISSING,
        errorSince: 123,
      }
    );
    const fresh = normalizeErrorFields(
      { error: BLOG_DIRECTORY_DELETED, errorCode: health.CODES.SOURCE_MISSING },
      { error: null, errorCode: null, errorSince: null }
    );
    const after = Date.now();

    [changed, fresh].forEach(function (fields) {
      expect(fields.errorSince).toBeGreaterThanOrEqual(before);
      expect(fields.errorSince).toBeLessThanOrEqual(after);
    });
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
    expect(
      isSetupInProgress({
        setupComplete: false,
        sharingLink: "https://www.icloud.com/iclouddrive/abc",
        error: null,
        errorCode: health.CODES.SOURCE_MISSING,
      })
    ).toBe(true);
    expect(isSetupInProgress({ setupComplete: true })).toBe(false);
    expect(
      isSetupInProgress({ setupComplete: true, transferringToiCloud: true })
    ).toBe(true);
  });
});
