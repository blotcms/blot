describe("cdn when redis is unavailable", function () {
  const Express = require("express");
  const fetch = require("node-fetch");
  const client = require("models/client");
  const { ClientOfflineError, SimpleError } = require("redis");
  const { redisUnavailableHandler } = require("helper/redisUnavailable");

  const hash = "0123456789abcdef0123456789abcdef";
  let server, origin;

  beforeEach(function (done) {
    const app = Express();
    app.use(require("cdn"));
    app.use(redisUnavailableHandler);
    server = app.listen(0, function () {
      origin = "http://127.0.0.1:" + server.address().port;
      done();
    });
  });

  afterEach(function (done) {
    server.close(done);
  });

  it("responds 503, not 404, when a rendered template cannot be read", async function () {
    spyOn(client, "get").and.callFake(() =>
      Promise.reject(new ClientOfflineError())
    );

    const res = await fetch(origin + "/template/style." + hash + ".css");

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("responds 503 when redis is still loading its dataset", async function () {
    spyOn(client, "get").and.callFake(() =>
      Promise.reject(
        new SimpleError("LOADING Redis is loading the dataset in memory")
      )
    );

    const res = await fetch(origin + "/template/style." + hash + ".css");

    expect(res.status).toBe(503);
  });

  it("still responds 404 for a template which does not exist", async function () {
    spyOn(client, "get").and.callFake(() => Promise.resolve(null));

    const res = await fetch(origin + "/template/style." + hash + ".css");

    expect(res.status).toBe(404);
  });
});
