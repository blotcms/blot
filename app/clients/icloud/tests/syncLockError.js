const { handleSyncLockError } = require("../routes/lock");

// What the macserver is told when a request can't take the folder lock, or
// is stopped while it holds it (sync/seize.js)
describe("icloud handleSyncLockError", function () {
  const fakeRes = () => {
    const res = {
      headersSent: false,
      statusCode: null,
      headers: {},
      set(name, value) {
        res.headers[name] = value;
        return res;
      },
      status(code) {
        res.statusCode = code;
        return res;
      },
      send() {
        return res;
      },
    };
    return res;
  };

  const lockError = (cause) =>
    new Error("Failed to acquire folder lock", { cause });

  const handle = (err) => {
    const res = fakeRes();
    const handled = handleSyncLockError({
      err,
      res,
      blogID: "blog",
      action: "upload",
    });
    return { handled, res };
  };

  beforeEach(function () {
    spyOn(console, "warn");
  });

  it("asks for a retry when another sync holds the lock", function () {
    const { handled, res } = handle(lockError());

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(423);
    expect(res.headers["Retry-After"]).toBe("10");
  });

  it("drops the change when the lock was refused for a disconnect", function () {
    const { handled, res } = handle(
      lockError(
        Object.assign(new Error(), { code: "ELOCKED", reason: "disconnect" })
      )
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(410);
  });

  it("drops the change when a disconnect stopped the request", function () {
    const { handled, res } = handle(
      Object.assign(new Error("Sync cancelled"), {
        code: "ECANCELED",
        reason: "disconnect",
      })
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(410);
  });

  it("asks for a retry when the request was stopped for another reason", function () {
    const { handled, res } = handle(
      Object.assign(new Error("Sync cancelled"), {
        code: "ECANCELED",
        reason: "drain",
      })
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(423);
  });

  it("leaves other errors alone", function () {
    const { handled, res } = handle(new Error("boom"));

    expect(handled).toBe(false);
    expect(res.statusCode).toBe(null);
  });
});
