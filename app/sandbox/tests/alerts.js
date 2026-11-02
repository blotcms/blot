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
    expect(lines.split("\n").sort()).toEqual(["1 × job screenshot: timeout", "2 × job thumbnail: killed"]);
  });

  describe("checkProxy", function () {
    let server;

    function proxy(status) {
      return new Promise((resolve) => {
        server = http.createServer((req, res) => {
          res.statusCode = status;
          res.end();
        });
        server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
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
      expect(await alerts.checkProxy(await proxy(200))).toContain("let the metadata address through");
    });

    it("reports a proxy that does not answer", async function () {
      const url = await proxy(500);
      await new Promise((resolve) => server.close(resolve));
      server = null;
      expect(await alerts.checkProxy(url)).toContain("did not answer");
    });
  });
});
