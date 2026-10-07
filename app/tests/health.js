describe("/health", function () {
  const fetch = require("node-fetch");
  const Blog = require("models/blog");
  const { ClientOfflineError } = require("redis");
  const server = require("server");

  let listener, origin;

  beforeAll(function (done) {
    listener = server.listen(0, function () {
      origin = "http://localhost:" + listener.address().port;
      done();
    });
  });

  afterAll(function (done) {
    listener.close(done);
  });

  it("answers OK without looking anything up in redis", async function () {
    // The blog middleware looks up the request's host, so if /health came
    // after it a Redis outage would make every container unhealthy
    spyOn(Blog, "get").and.callFake(function (identifier, callback) {
      callback(new ClientOfflineError());
    });

    const res = await fetch(origin + "/health");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("OK");
    expect(Blog.get).not.toHaveBeenCalled();
  });
});
