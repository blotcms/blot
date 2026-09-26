const health = require("clients/health");
const {
  SOURCES,
  classify,
  isRetryable,
  dropboxTag,
  issueFromAccount,
  flagsFromAccount,
  backfillPatch,
  keepsErrorAfterDownload,
} = require("../util/classifyError");
const tagSource = require("../util/tagSource");

function apiError(status, tag, extra) {
  const err = Object.assign({ status: status }, extra || {});
  if (tag) {
    err.error = { error: { ".tag": tag } };
  }
  return err;
}

describe("dropbox classifyError", function () {
  describe("classify", function () {
    it("maps 401 from any step to REAUTH_REQUIRED", function () {
      const classified = classify(apiError(401, "invalid_access_token"), SOURCES.DELTA);

      expect(classified.persist).toBe(true);
      expect(classified.healthCode).toBe(health.CODES.REAUTH_REQUIRED);
      expect(classified.status).toBe(401);
    });

    it("stores a tagged auth failure from a later step under the auth source", function () {
      const err = { status: 400, error: { error: "invalid_grant" } };
      const classified = classify(err, SOURCES.APPLY);

      expect(classified.source).toBe(SOURCES.AUTH);
      expect(
        issueFromAccount({
          error_code: classified.status,
          error_source: classified.source,
        }).code
      ).toBe(health.CODES.REAUTH_REQUIRED);
    });

    it("maps invalid_grant from token refresh to REAUTH_REQUIRED", function () {
      const err = {
        status: 400,
        error: { error: "invalid_grant", error_description: "revoked" },
      };
      const classified = classify(err, SOURCES.AUTH);

      expect(classified.persist).toBe(true);
      expect(classified.healthCode).toBe(health.CODES.REAUTH_REQUIRED);
      expect(dropboxTag(err)).toBe("invalid_grant");
    });

    it("does not treat an untagged 400 from the auth step as a revoked grant", function () {
      expect(classify({ status: 400 }, SOURCES.AUTH).persist).toBe(false);
    });

    it("does not persist a transient auth-step failure", function () {
      expect(classify({ status: 429 }, SOURCES.AUTH).persist).toBe(false);
      expect(classify({ status: 503 }, SOURCES.AUTH).persist).toBe(false);
      expect(classify({ code: "ETIMEDOUT" }, SOURCES.AUTH).persist).toBe(false);
    });

    it("maps a delta 409 to SOURCE_MISSING", function () {
      const classified = classify(
        apiError(409, "path"),
        SOURCES.DELTA
      );

      expect(classified.persist).toBe(true);
      expect(classified.healthCode).toBe(health.CODES.SOURCE_MISSING);
    });

    it("does not treat an apply 409 as SOURCE_MISSING", function () {
      const classified = classify(
        { statusCode: 409, statusMessage: "Conflict" },
        SOURCES.APPLY
      );

      expect(classified.persist).toBe(false);
      expect(classified.healthCode).toBe(null);
    });

    it("maps a nested insufficient_space on a 409 to QUOTA_EXCEEDED with status 507", function () {
      const err = {
        status: 409,
        error: { error_summary: "path/insufficient_space/..." },
      };
      const classified = classify(err, SOURCES.APPLY);

      expect(classified.healthCode).toBe(health.CODES.QUOTA_EXCEEDED);
      expect(classified.status).toBe(507);
    });

    it("maps 507 / insufficient_space to QUOTA_EXCEEDED", function () {
      const classified = classify(
        apiError(507, "insufficient_space"),
        SOURCES.APPLY
      );

      expect(classified.persist).toBe(true);
      expect(classified.healthCode).toBe(health.CODES.QUOTA_EXCEEDED);
    });

    it("does not persist 429, 500, or untagged 400 from delta", function () {
      expect(classify({ status: 429 }, SOURCES.DELTA).persist).toBe(false);
      expect(classify({ status: 500 }, SOURCES.DELTA).persist).toBe(false);
      expect(classify({ status: 400 }, SOURCES.DELTA).persist).toBe(false);
    });
  });

  describe("isRetryable", function () {
    it("does not retry user-actionable or hopeless errors", function () {
      expect(isRetryable(apiError(401))).toBe(false);
      expect(isRetryable(apiError(409))).toBe(false);
      expect(isRetryable(apiError(507, "insufficient_space"))).toBe(false);
      expect(isRetryable({ code: "ENAMETOOLONG" })).toBe(false);
      expect(
        isRetryable({ status: 400, error: { error: "invalid_grant" } })
      ).toBe(false);
    });

    it("retries transient failures", function () {
      expect(isRetryable({ status: 429 })).toBe(true);
      expect(isRetryable({ status: 500 })).toBe(true);
      expect(isRetryable({ code: "ECONNRESET" })).toBe(true);
    });
  });

  describe("issueFromAccount", function () {
    it("maps a legacy 401 with no source to REAUTH_REQUIRED", function () {
      const issue = issueFromAccount({ error_code: 401, error_since: 10 });

      expect(issue).toEqual({
        code: health.CODES.REAUTH_REQUIRED,
        since: 10,
      });
    });

    it("maps a legacy 409 with no source to SOURCE_MISSING", function () {
      expect(issueFromAccount({ error_code: 409 }).code).toBe(
        health.CODES.SOURCE_MISSING
      );
    });

    it("does not surface a 409 stored from apply", function () {
      expect(
        issueFromAccount({ error_code: 409, error_source: SOURCES.APPLY })
      ).toBe(null);
    });

    it("maps auth-source 400 (invalid grant) to REAUTH_REQUIRED", function () {
      expect(
        issueFromAccount({ error_code: 400, error_source: SOURCES.AUTH }).code
      ).toBe(health.CODES.REAUTH_REQUIRED);
    });

    it("maps a legacy unsourced 400 (refresh failure) to REAUTH_REQUIRED", function () {
      expect(issueFromAccount({ error_code: 400 }).code).toBe(
        health.CODES.REAUTH_REQUIRED
      );
      expect(backfillPatch({ error_code: 400, last_sync: 5 })).toEqual({
        error_source: SOURCES.AUTH,
        error_since: 5,
      });
    });

    it("keeps only quota errors through a download-only pass", function () {
      expect(keepsErrorAfterDownload({ error_code: 507 })).toBe(true);
      expect(keepsErrorAfterDownload({ error_code: 401 })).toBe(false);
      expect(keepsErrorAfterDownload({ error_code: 0 })).toBe(false);
    });

    it("does not surface a stale transient error_code", function () {
      expect(issueFromAccount({ error_code: 429 })).toBe(null);
      expect(issueFromAccount({ error_code: 500 })).toBe(null);
      expect(issueFromAccount({ error_code: 0 })).toBe(null);
      expect(issueFromAccount(null)).toBe(null);
    });

    it("maps 507 to QUOTA_EXCEEDED", function () {
      expect(issueFromAccount({ error_code: 507 }).code).toBe(
        health.CODES.QUOTA_EXCEEDED
      );
    });
  });

  describe("flagsFromAccount", function () {
    it("sets dashboard flags from the health issue", function () {
      expect(flagsFromAccount({ error_code: 401 })).toEqual({
        revoked: true,
        folder_missing: false,
        quota_exceeded: false,
      });
      expect(flagsFromAccount({ error_code: 409 })).toEqual({
        revoked: false,
        folder_missing: true,
        quota_exceeded: false,
      });
      expect(flagsFromAccount({ error_code: 507 })).toEqual({
        revoked: false,
        folder_missing: false,
        quota_exceeded: true,
      });
      expect(flagsFromAccount({ error_code: 500 })).toEqual({
        revoked: false,
        folder_missing: false,
        quota_exceeded: false,
      });
    });
  });

  describe("backfillPatch", function () {
    it("stamps error_source on legacy 401 and 409 rows", function () {
      expect(backfillPatch({ error_code: 401, last_sync: 5 })).toEqual({
        error_source: SOURCES.AUTH,
        error_since: 5,
      });
      const missingFolder = backfillPatch({ error_code: 409 });
      expect(missingFolder.error_source).toBe(SOURCES.DELTA);
      expect(typeof missingFolder.error_since).toBe("number");
      expect(missingFolder.error_since).toBeGreaterThan(0);
    });

    it("clears stale transient error_codes", function () {
      expect(backfillPatch({ error_code: 500 })).toEqual({
        error_code: 0,
        error_source: "",
        error_since: 0,
      });
      expect(backfillPatch({ error_code: 429 })).toEqual({
        error_code: 0,
        error_source: "",
        error_since: 0,
      });
    });

    it("leaves a fully stamped actionable row alone", function () {
      expect(
        backfillPatch({
          error_code: 401,
          error_source: SOURCES.AUTH,
          error_since: 99,
        })
      ).toBe(null);
    });

    it("does not overwrite an existing error_source", function () {
      expect(
        backfillPatch({
          error_code: 409,
          error_source: SOURCES.APPLY,
          error_since: 1,
        })
      ).toBe(null);
    });

    it("keeps an auth-source 400 rather than treating it as transient", function () {
      expect(
        backfillPatch({
          error_code: 400,
          error_source: SOURCES.AUTH,
          error_since: 1,
        })
      ).toBe(null);
    });
  });

  describe("tagSource", function () {
    it("tags a rejection with the step and rethrows it", async function () {
      const err = { status: 409 };

      await tagSource(SOURCES.DELTA, Promise.reject(err)).then(
        function () {
          throw new Error("expected rejection");
        },
        function (thrown) {
          expect(thrown).toBe(err);
          expect(thrown.dropboxSource).toBe(SOURCES.DELTA);
        }
      );
    });

    it("keeps the first tag", async function () {
      const err = { status: 409, dropboxSource: SOURCES.DELTA };

      await tagSource(SOURCES.APPLY, Promise.reject(err)).catch(function () {});

      expect(err.dropboxSource).toBe(SOURCES.DELTA);
    });
  });
});
