describe("Blot configuration", function () {
  // The test to start the main server
  // and resolve unused dependencies both
  // needs a little longer to run. 50s should be plenty
  global.test.timeout(50 * 1000);

  // TODO: check that g
  it("config loads without error", function () {
    expect(function () {
      require("config");
    }).not.toThrow();
  });

  var fetch = require("node-fetch");
  // The app builds templates once it is listening, under a Redis lock that
  // only expires after 60s if the holder is killed mid-build. Killing the
  // app before that finishes would leave the lock behind, and the next
  // spec to build templates in this process would wait it out.
  var START_MESSAGE = "Built templates after listen";
  var server;
  var stderr = "";
  var stdout = "";

  beforeAll(function (done) {
    server = require("child_process").fork(__dirname + "/../../../app", {
      silent: true
    });

    // App should not emit anything on standard error
    server.stderr.on("data", function (data) {
      stderr += data.toString("utf8") + "\n";
    });

    // Wait for the app to be listening and to have built its templates
    server.stdout.on("data", function (data) {
      stdout += data.toString("utf8");

      if (stdout.indexOf(START_MESSAGE) > -1) {
        stdout = "";
        done();
      }
    });
  });

  afterAll(function (done) {
    server.on("exit", function () {
      done();
    });

    server.kill();
  });

  it("returns OK at the health endpoint", async function () {
    console.log("fetching health");

    const res = await fetch("http://localhost:8080/health");

    expect(res.status).toBe(200);

    console.log("fetching health body");

    const body = await res.text();

    expect(body).toEqual("OK");
  });

  it("can connect to redis", function (done) {
    require("models/client")
      .ping()
      .then(function (res) {
        expect(res).toBe("PONG");
        done();
      })
      .catch(done.fail);
  });
});
