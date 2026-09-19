const health = require("clients/health");
const {
  SETUP_ERROR,
  MESSAGES,
  classify,
  classifyFromProse,
  sourceMissingFields,
  lostFolderMessage,
  clearAllErrorFields,
  clearHealthErrorFields,
  backfillPatch,
  isLostFolderError,
  isTransientDriveError,
  isQuotaError,
  isSetupError,
} = require("../error");

describe("google drive database.error", function () {
  it("classifies trash, delete, and inaccessible prose as SOURCE_MISSING", function () {
    expect(classifyFromProse(MESSAGES.TRASHED)).toBe(health.CODES.SOURCE_MISSING);
    expect(classifyFromProse(MESSAGES.DELETED)).toBe(health.CODES.SOURCE_MISSING);
    expect(classifyFromProse(MESSAGES.INACCESSIBLE)).toBe(
      health.CODES.SOURCE_MISSING
    );
  });

  it("does not treat setup failures as sync health", function () {
    expect(isSetupError(SETUP_ERROR)).toBe(true);
    expect(classifyFromProse(SETUP_ERROR)).toBeNull();
    expect(classify({ error: SETUP_ERROR })).toBeNull();
  });

  it("prefers a stored errorCode over prose", function () {
    expect(
      classify({
        error: SETUP_ERROR,
        errorCode: health.CODES.SOURCE_MISSING,
      })
    ).toBe(health.CODES.SOURCE_MISSING);
  });

  it("ignores unknown errorCode values and falls back to prose", function () {
    expect(
      classify({
        error: MESSAGES.DELETED,
        errorCode: "NOPE",
      })
    ).toBe(health.CODES.SOURCE_MISSING);
  });

  it("preserves errorSince when the same SOURCE_MISSING is written again", function () {
    const first = sourceMissingFields(null, MESSAGES.TRASHED, 1000);
    const second = sourceMissingFields(first, MESSAGES.DELETED, 2000);

    expect(first.errorSince).toBe(1000);
    expect(second.errorSince).toBe(1000);
    expect(second.error).toBe(MESSAGES.DELETED);
    expect(second.folderId).toBeNull();
    expect(second.folderName).toBeNull();
  });

  it("clears health fields without touching setup prose", function () {
    expect(clearHealthErrorFields()).toEqual({
      errorCode: null,
      errorSince: null,
    });
    expect(clearAllErrorFields()).toEqual({
      error: null,
      errorCode: null,
      errorSince: null,
    });
  });

  it("backfills missing errorCode from legacy prose and skips rows that already match", function () {
    expect(backfillPatch({ error: MESSAGES.TRASHED })).toEqual({
      errorCode: health.CODES.SOURCE_MISSING,
    });
    expect(
      backfillPatch({
        error: MESSAGES.TRASHED,
        errorCode: health.CODES.SOURCE_MISSING,
      })
    ).toBeNull();
  });

  it("clears a health code left on a setup-failure row", function () {
    expect(
      backfillPatch({
        error: SETUP_ERROR,
        errorCode: health.CODES.SYNC_ERROR,
        errorSince: 1,
      })
    ).toEqual({ errorCode: null, errorSince: null });
  });

  it("treats 404 and permission-denied 403 as a lost folder", function () {
    expect(isLostFolderError({ code: 404 })).toBe(true);
    expect(
      isLostFolderError({
        code: 403,
        errors: [{ reason: "insufficientFilePermissions" }],
      })
    ).toBe(true);
    expect(lostFolderMessage({ code: 404 })).toBe(MESSAGES.DELETED);
    expect(lostFolderMessage({ code: 403 })).toBe(MESSAGES.INACCESSIBLE);
  });

  it("does not treat quota or rate-limit errors as a lost folder", function () {
    const quota = {
      code: 403,
      errors: [{ reason: "storageQuotaExceeded" }],
    };
    const rateLimit = { code: 429 };

    expect(isQuotaError(quota)).toBe(true);
    expect(isLostFolderError(quota)).toBe(false);
    expect(isTransientDriveError(rateLimit)).toBe(true);
    expect(isLostFolderError(rateLimit)).toBe(false);
    expect(isLostFolderError({ code: 500 })).toBe(false);
  });
});
