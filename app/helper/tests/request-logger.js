describe("request logger", function () {
  const EventEmitter = require("events");
  const config = require("config");
  const loggerPath = require.resolve("request-logger");

  let environment, lines, clock;

  // Loads the logger as production loads it: steps are held, not printed
  function requestLogger() {
    config.environment = "production";
    delete require.cache[loggerPath];
    return require("request-logger");
  }

  function request() {
    const req = {
      headers: { "x-request-id": "abc123" },
      protocol: "https",
      hostname: "example.com",
      originalUrl: "/page",
      method: "GET",
    };
    const res = new EventEmitter();
    res.statusCode = 200;
    res.writableFinished = false;
    requestLogger()(req, res, () => {});
    return { req, res };
  }

  function finish(res, statusCode) {
    res.statusCode = statusCode || 200;
    res.writableFinished = true;
    res.emit("finish");
    res.emit("close");
  }

  const steps = () => lines.filter((line) => / \+\d+ms /.test(line));

  beforeEach(function () {
    environment = config.environment;
    lines = [];
    spyOn(console, "log").and.callFake((line) => lines.push(line));
    clock = 0;
    spyOn(Date, "now").and.callFake(() => clock);
  });

  afterEach(function () {
    config.environment = environment;
    delete require.cache[loggerPath];
  });

  it("prints nothing of a fast request's steps", function () {
    const { req, res } = request();
    req.log("Loading blog");
    clock += 20;
    req.log("Loaded blog");
    finish(res);

    expect(steps()).toEqual([]);
    expect(lines[lines.length - 1]).toMatch(
      / abc123 200 0\.020 https:\/\/example\.com\/page .*slowest=\+20ms:"Loaded blog"/
    );
  });

  it("prints a slow request's steps before its response line", function () {
    const { req, res } = request();
    req.log("Loading blog");
    clock += 1500;
    req.log("Loaded blog");
    finish(res);

    expect(steps().length).toBe(2);
    expect(steps()[1]).toMatch(/ abc123 \+1500ms Loaded blog$/);
    expect(lines.indexOf(steps()[1])).toBeLessThan(lines.length - 1);
  });

  it("prints a failed request's steps", function () {
    const { req, res } = request();
    req.log("Loading entry");
    finish(res, 500);

    expect(steps().length).toBe(1);
  });

  it("prints the steps of a request the client left", function () {
    const { req, res } = request();
    req.log("Retrieving local", "cdn");
    res.emit("close");

    expect(steps()).toEqual([jasmine.stringMatching(/Retrieving local cdn$/)]);
    expect(lines[lines.length - 1]).toMatch(/Connection closed by client/);
  });

  it("prints logNow lines at once", function () {
    const { req } = request();
    req.logNow("[folder-asset]", "blog=blog_1");

    expect(steps()).toEqual([
      jasmine.stringMatching(/ abc123 \+0ms \[folder-asset\] blog=blog_1$/),
    ]);
  });

  it("holds at most 200 steps and says how many it left out", function () {
    const { req, res } = request();
    for (let i = 0; i < 205; i++) req.log("step", i);
    finish(res, 503);

    expect(steps().length).toBe(200);
    expect(lines).toContain(
      jasmine.stringMatching(/ abc123 \(5 more steps not logged\)$/)
    );
  });
});
