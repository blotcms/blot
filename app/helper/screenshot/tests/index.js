const express = require("express");
const screenshot = require("../index.js");
const fs = require("fs-extra");
const hashFile = require("helper/hashFile");

describe("screenshot plugin", function () {
  let server;

  global.test.timeout(60 * 1000); // 60s

  const port = 7623;
  const site = `http://localhost:${port}`;
  const path = __dirname + "/data/screenshot.png";
  const expectedPath = __dirname + "/expected.png";
  let requestTimes = [];

  beforeAll((done) => {
    const app = express();

    // Return 404 for favicon requests
    app.get("/favicon.ico", (req, res) => {
      res.status(404).send("Not found");
    });

    // Track request times for rate limiting tests
    app.use((req, res, next) => {
      requestTimes.push(Date.now());
      console.log(`Request ${requestTimes.length} received`);
      next();
    });

    app.get("/", (req, res) => {
      console.log("sending response");
      res.send(
        "<html><head><style>body{background:white}</style></head><body><h1>Hello, world!</h1></body></html>"
      );
    });

    server = app.listen(port, done);
  });

  beforeEach(() => {
    requestTimes = [];
    // Clean up any leftover screenshots
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
    }
  });

  afterAll(() => {
    console.log("Closing server");
    server.close();
  });

  it("creates matching screenshot", async function () {
    const expectedHash = await hashFile(expectedPath);
    await screenshot(site, path);
    expect(fs.existsSync(path)).toBe(true);
    const hash = await hashFile(path);

    if (hash !== expectedHash) {
      throw new Error(
        `Screenshot does not match expected hash, please check ./data/screenshot.png`
      );
    }

    fs.unlinkSync(path);
  });

  it("handles browser restarts smoothly", async function () {
    const requests = 10; // Reduced number of requests for stability
    const paths = Array.from(
      { length: requests },
      (_, i) => `${__dirname}/data/screenshot_${i}.png`
    );

    console.log(`Starting restart with ${requests} requests`);
    console.log(paths);

    setTimeout(() => {
      // Wait 2 seconds to ensure some requests have started
      screenshot.restart();
    }, 2000);

    // Issue screenshot requests in parallel and await all to finish
    // this should take ~10 seconds
    await Promise.all(paths.map((p) => screenshot(site, p)));

    // Cleanup
    for (const p of paths) {
      if (fs.existsSync(p)) {
        const expectedHash = await hashFile(expectedPath);
        const hash = await hashFile(p);
        if (hash !== expectedHash) {
          throw new Error(
            `Screenshot at ${p} does not match expected hash, please check the file.`
          );
        }
        fs.unlinkSync(p);
      }
    }
  });

  it("respects rate limiting", async function () {
    const requests = 10;
    const paths = Array.from(
      { length: requests },
      (_, i) => `${__dirname}/data/screenshot_${i}.png`
    );

    console.log(`Starting rate limiting test with ${requests} requests`);
    console.log(paths);

    // Execute requests in parallel and await all to finish
    await Promise.all(paths.map((p) => screenshot(site, p)));

    // Log the requests and their corresponding times
    console.log(
      requestTimes.map((t, i) => `Request ${i + 1}: ${t}`).join("\n")
    );

    // Check time differences between requests
    const timeDiffs = [];
    for (let i = 1; i < requestTimes.length; i++) {
      timeDiffs.push(requestTimes[i] - requestTimes[i - 1]);
    }

    // log the time differences, e.g. 'Diff between req 1 and 2: 1000ms'
    console.log(
      timeDiffs
        .map((diff, i) => `Diff between req ${i + 1} and ${i + 2}: ${diff}ms`)
        .join("\n")
    );

    // calculate the average time difference
    const averageDiff = timeDiffs.reduce((a, b) => a + b) / timeDiffs.length;

    // verify the average time difference is greater than 500ms
    expect(averageDiff).toBeGreaterThan(500);

    // Cleanup
    for (const p of paths) {
      if (fs.existsSync(p)) {
        const expectedHash = await hashFile(expectedPath);
        const hash = await hashFile(p);
        if (hash !== expectedHash) {
          throw new Error(
            `Screenshot at ${p} does not match expected hash, please check the file.`
          );
        }
        fs.unlinkSync(p);
      }
    }
  });
});
