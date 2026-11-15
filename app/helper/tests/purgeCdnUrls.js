const config = require("config");

const purgeCdnUrlsPath = require.resolve("../purgeCdnUrls");
const fetchModulePath = require.resolve("node-fetch");
const bottleneckModulePath = require.resolve("bottleneck");

const realFetch = require(fetchModulePath);
const realBottleneck = require(bottleneckModulePath);

function resetModule(modulePath, realExports) {
  if (require.cache[modulePath]) {
    require.cache[modulePath].exports = realExports;
  }
}

describe("purgeCdnUrls", function () {
  const originalEnvironment = config.environment;
  const originalBunny = config.bunny;

  let purgeCdnUrls;
  let fetchSpy;
  let scheduleSpy;
  let clockInstalled;

  function loadWithMocks({ fetchImpl, bottleneckImpl } = {}) {
    delete require.cache[purgeCdnUrlsPath];

    if (fetchImpl) {
      require.cache[fetchModulePath] = {
        id: fetchModulePath,
        filename: fetchModulePath,
        loaded: true,
        exports: fetchImpl,
      };
    } else {
      resetModule(fetchModulePath, realFetch);
    }

    if (bottleneckImpl) {
      require.cache[bottleneckModulePath] = {
        id: bottleneckModulePath,
        filename: bottleneckModulePath,
        loaded: true,
        exports: bottleneckImpl,
      };
    } else {
      resetModule(bottleneckModulePath, realBottleneck);
    }

    purgeCdnUrls = require(purgeCdnUrlsPath);
  }

  beforeEach(function () {
    clockInstalled = false;
    fetchSpy = jasmine.createSpy("fetch");
    scheduleSpy = jasmine.createSpy("schedule").and.callFake((job) => job());

    function FakeBottleneck() {
      this.schedule = scheduleSpy;
    }

    loadWithMocks({ fetchImpl: fetchSpy, bottleneckImpl: FakeBottleneck });

    config.environment = "production";
    config.bunny = { secret: "test-secret" };

    spyOn(console, "log");
    spyOn(console, "error");
    spyOn(global.Math, "random").and.returnValue(0);
  });

  afterEach(function () {
    config.environment = originalEnvironment;
    config.bunny = originalBunny;

    resetModule(fetchModulePath, realFetch);
    resetModule(bottleneckModulePath, realBottleneck);
    delete require.cache[purgeCdnUrlsPath];

    if (clockInstalled) {
      jasmine.clock().uninstall();
    }
  });

  it("does nothing in non-production environments", async function () {
    config.environment = "development";

    await purgeCdnUrls(["https://example.com/test"]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("does nothing when bunny secret is missing", async function () {
    config.bunny = null;

    await purgeCdnUrls(["https://example.com/test"]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("does nothing when bunny secret is empty", async function () {
    config.bunny = { secret: "" };

    await purgeCdnUrls(["https://example.com/test"]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("does nothing with empty URL array", async function () {
    await purgeCdnUrls([]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("does nothing with null/undefined URLs", async function () {
    await purgeCdnUrls(null);
    await purgeCdnUrls(undefined);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).not.toHaveBeenCalled();
  });

  it("retries once on 429 and then succeeds", async function () {
    jasmine.clock().install();
    clockInstalled = true;

    const firstResponse = {
      status: 429,
      headers: {
        get(name) {
          if (String(name).toLowerCase() === "retry-after") {
            return "1";
          }

          return null;
        },
      },
    };

    const successResponse = {
      status: 200,
      headers: { get: () => null },
    };

    fetchSpy.and.returnValues(
      Promise.resolve(firstResponse),
      Promise.resolve(successResponse)
    );

    const promise = purgeCdnUrls(["https://example.com/test"]);
    await Promise.resolve();
    jasmine.clock().tick(1000);
    await promise;

    expect(fetchSpy.calls.count()).toBe(2);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      "Purged Bunny CDN: https://example.com/test (attempt 2/4)"
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it("stops retrying after max retries on repeated 429", async function () {
    spyOn(global, "setTimeout").and.callFake((fn) => {
      fn();
      return 0;
    });

    fetchSpy.and.returnValue(
      Promise.resolve({
        status: 429,
        headers: { get: () => null },
      })
    );

    await purgeCdnUrls(["https://example.com/test"]);

    expect(fetchSpy.calls.count()).toBe(4);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to purge Bunny CDN: https://example.com/test (attempt 4/4)",
      429
    );
  });

  it("uses limiter scheduling for each URL", async function () {
    fetchSpy.and.returnValue(
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
      })
    );

    await purgeCdnUrls(["https://example.com/one", "https://example.com/two"]);

    expect(scheduleSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps encoded purge URL behavior unchanged", async function () {
    fetchSpy.and.returnValue(
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
      })
    );

    await purgeCdnUrls(["https://example.com/test?a=1&b=2"]);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.bunny.net/purge?url=https%3A%2F%2Fexample.com%2Ftest%3Fa%3D1%26b%3D2&async=false",
      jasmine.objectContaining({
        method: "POST",
        headers: { AccessKey: "test-secret" },
        timeout: 60000,
      })
    );
  });

  it("logs nothing for a success when quiet", async function () {
    fetchSpy.and.returnValue(
      Promise.resolve({ status: 200, headers: { get: () => null } })
    );

    expect(
      await purgeCdnUrls(["https://example.com/test"], { quiet: true })
    ).toBe(true);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("is false if any purge fails", async function () {
    fetchSpy.and.returnValues(
      Promise.resolve({ status: 200, headers: { get: () => null } }),
      Promise.resolve({ status: 500, headers: { get: () => null } })
    );

    expect(
      await purgeCdnUrls(["https://example.com/one", "https://example.com/two"])
    ).toBe(false);
  });
});
