describe("sandbox alerts", function () {
  const http = require("http");
  const email = require("helper/email");
  const config = require("config");
  const alerts = require("../alerts");

  const error = (code) => Object.assign(new Error(code), { code });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  let preview;

  beforeEach(function () {
    preview = config.preview;
    config.preview = false;
    alerts.reset();
    spyOn(email, "SANDBOX_ALERT");
  });

  afterEach(function () {
    config.preview = preview;
    alerts.reset();
  });

  it("emails a burst of crashes once, counted, and skips bad input", async function () {
    alerts.jobFailed("thumbnail", error("SANDBOX_KILLED"));
    alerts.jobFailed("thumbnail", error("SANDBOX_KILLED"));
    alerts.jobFailed("screenshot", error("SANDBOX_TIMEOUT"));
    alerts.jobFailed("thumbnail", error("SANDBOX_FAILED"));
    alerts.jobFailed("thumbnail", new Error("not ours"));
    await tick();

    expect(email.SANDBOX_ALERT).toHaveBeenCalledTimes(1);
    const { lines } = email.SANDBOX_ALERT.calls.argsFor(0)[1];
    expect(lines.split("\n").sort()).toEqual([
      "1 × job screenshot: timeout",
      "2 × job thumbnail: killed",
    ]);
  });

  it("logs a busy fetch-image job, which is backpressure, but emails busy from the others", async function () {
    spyOn(console, "log");
    alerts.jobFailed("fetch-image", error("SANDBOX_BUSY"));
    alerts.jobFailed("fetch-image", error("SANDBOX_BUSY"));
    await tick();

    expect(email.SANDBOX_ALERT).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledTimes(2);
    expect(console.log.calls.argsFor(1)[1]).toBe(
      "sandbox: job fetch-image busy (2 since start)"
    );

    alerts.jobFailed("thumbnail", error("SANDBOX_BUSY"));
    await tick();
    expect(email.SANDBOX_ALERT).toHaveBeenCalledTimes(1);
    expect(email.SANDBOX_ALERT.calls.argsFor(0)[1].lines).toBe(
      "1 × job thumbnail: busy"
    );
  });

  for (const job of ["pandoc", "thumbnail"]) {
    it(`logs a ${job} job killed for taking too long, which is the input's doing, but emails it killed`, async function () {
      spyOn(console, "log");
      alerts.jobFailed(job, error("SANDBOX_TIMEOUT"));
      await tick();
      expect(email.SANDBOX_ALERT).not.toHaveBeenCalled();
      expect(console.log.calls.argsFor(0)[1]).toBe(
        `sandbox: job ${job} timed out`
      );

      alerts.jobFailed(job, error("SANDBOX_KILLED"));
      await tick();
      expect(email.SANDBOX_ALERT).toHaveBeenCalledTimes(1);
      expect(email.SANDBOX_ALERT.calls.argsFor(0)[1].lines).toBe(
        `1 × job ${job}: killed`
      );
    });
  }

  it("emails a failed fetch-image job, which answers bad input with meta.error", async function () {
    alerts.jobFailed("fetch-image", error("SANDBOX_FAILED"));
    await tick();

    expect(email.SANDBOX_ALERT).toHaveBeenCalledTimes(1);
    expect(email.SANDBOX_ALERT.calls.argsFor(0)[1].lines).toBe(
      "1 × job fetch-image: failed"
    );
  });

  it("logs a busy screenshot batch, which the client sends again", async function () {
    spyOn(console, "log");
    alerts.jobFailed("screenshot", error("SANDBOX_BUSY"));
    await tick();

    expect(email.SANDBOX_ALERT).not.toHaveBeenCalled();
    expect(console.log.calls.argsFor(0)[1]).toBe(
      "sandbox: job screenshot busy (1 since start)"
    );
  });

  it("logs a busy fetch job like fetch-image's, and emails the real failures", async function () {
    spyOn(console, "log");
    alerts.jobFailed("fetch", error("SANDBOX_BUSY"));
    await tick();

    expect(email.SANDBOX_ALERT).not.toHaveBeenCalled();
    expect(console.log.calls.argsFor(0)[1]).toBe(
      "sandbox: job fetch busy (1 since start)"
    );

    alerts.jobFailed("fetch", error("SANDBOX_FAILED"));
    alerts.jobFailed("fetch", error("SANDBOX_KILLED"));
    alerts.jobFailed("fetch", error("SANDBOX_TIMEOUT"));
    alerts.jobFailed("fetch", error("SANDBOX_UNAVAILABLE"));
    await tick();

    expect(email.SANDBOX_ALERT).toHaveBeenCalledTimes(1);
    expect(
      email.SANDBOX_ALERT.calls.argsFor(0)[1].lines.split("\n").sort()
    ).toEqual([
      "1 × job fetch: failed",
      "1 × job fetch: killed",
      "1 × job fetch: timeout",
      "1 × job fetch: unavailable",
    ]);
  });

  describe("checkProxy", function () {
    let server;

    function proxy(status) {
      return new Promise((resolve) => {
        server = http.createServer((req, res) => {
          res.statusCode = status;
          res.end();
        });
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${server.address().port}`)
        );
      });
    }

    afterEach(function (done) {
      if (!server) return done();
      server.close(() => done());
      server = null;
    });

    it("is happy when the proxy refuses the metadata address", async function () {
      expect(await alerts.checkProxy(await proxy(500))).toBeNull();
    });

    it("reports a proxy that lets the metadata address through", async function () {
      expect(await alerts.checkProxy(await proxy(200))).toContain(
        "let the metadata address through"
      );
    });

    it("reports a proxy that does not answer", async function () {
      const url = await proxy(500);
      await new Promise((resolve) => server.close(resolve));
      server = null;
      expect(await alerts.checkProxy(url)).toContain("did not answer");
    });
  });
});
