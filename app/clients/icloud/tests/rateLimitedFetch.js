const http = require("http");
const fetch = require("../util/rateLimitedFetchWithRetriesAndTimeout");

describe("icloud rateLimitedFetchWithRetriesAndTimeout", function () {
  let server;
  let url;
  let requests;
  let stallFirst;
  let trickle;
  let failFirst;
  let requestTimes;

  beforeEach(async function () {
    requests = 0;
    stallFirst = 0;
    trickle = false;
    failFirst = 0;
    requestTimes = [];
    server = http.createServer((req, res) => {
      requests++;
      requestTimes.push(Date.now());
      if (requests <= failFirst) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.setHeader("Content-Length", "5");
      res.writeHead(200);
      if (requests <= stallFirst) {
        // send headers and part of the body, then never finish
        res.write("he");
        return;
      }
      if (trickle) {
        // one byte every 100ms: slower overall than the timeout, never idle that long
        let i = 0;
        const interval = setInterval(() => {
          res.write("hello"[i++]);
          if (i === 5) {
            clearInterval(interval);
            res.end();
          }
        }, 100);
        return;
      }
      res.end("hello");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}/`;
    spyOn(console, "error");
  });

  afterEach(function (done) {
    server.closeAllConnections();
    server.close(() => done());
  });

  it("resolves to the body as a Buffer with readBody", async function () {
    const body = await fetch(url, { readBody: true });
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.toString()).toBe("hello");
  });

  it("waits retryDelay before the second attempt, doubling it after", async function () {
    failFirst = 2;
    const body = await fetch(url, { readBody: true, retryDelay: 100 });
    expect(body.toString()).toBe("hello");
    expect(requests).toBe(3);
    // Timers can fire a little early
    expect(requestTimes[1] - requestTimes[0]).toBeGreaterThanOrEqual(90);
    expect(requestTimes[2] - requestTimes[1]).toBeGreaterThanOrEqual(190);
  });

  it("retries straight away without retryDelay", async function () {
    failFirst = 2;
    const body = await fetch(url, { readBody: true });
    expect(body.toString()).toBe("hello");
    expect(requestTimes[2] - requestTimes[0]).toBeLessThan(1000);
  });

  it("retries when the body stalls after the headers arrive", async function () {
    stallFirst = 1;
    const body = await fetch(url, { readBody: true, timeout: 200 });
    expect(body.toString()).toBe("hello");
    expect(requests).toBe(2);
  });

  it("does not abort a slow body that keeps arriving", async function () {
    trickle = true;
    const body = await fetch(url, { readBody: true, timeout: 400 });
    expect(body.toString()).toBe("hello");
    expect(requests).toBe(1);
  });

  it("fails after the retries if the body always stalls", async function () {
    stallFirst = Infinity;
    let error;
    try {
      await fetch(url, { readBody: true, timeout: 100, retries: 2 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(requests).toBe(2);
  });
});
