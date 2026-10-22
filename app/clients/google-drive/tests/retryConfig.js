const retryConfig = require("../serviceAccount/retryConfig");

describe("google drive client retryConfig", function () {
  const createDriveClient = "../serviceAccount/createDriveClient";
  const stubs = {};

  function stub(name, exports) {
    const path = require.resolve(name);
    stubs[path] = require.cache[path];
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }

  afterEach(function () {
    for (const path of Object.keys(stubs)) {
      if (stubs[path]) require.cache[path] = stubs[path];
      else delete require.cache[path];
    }
    delete require.cache[require.resolve(createDriveClient)];
  });

  it("creates the client with longer backoff for 429 and 5xx", async function () {
    let options;

    stub("@googleapis/drive", {
      drive: (o) => (options = o),
      auth: { GoogleAuth: function () {} },
    });
    stub("config", { google_drive: { service_accounts: [{ client_id: "x" }] } });

    // Other specs may have loaded it already, bound to the real config
    delete require.cache[require.resolve(createDriveClient)];
    await require(createDriveClient)("x");

    expect(options.retryConfig).toBe(retryConfig);
    expect(retryConfig.retry).toBe(5);
    expect(retryConfig.retryDelay).toBe(500);
    expect(retryConfig.maxRetryDelay).toBe(8000);
    expect(retryConfig.statusCodesToRetry).toEqual([[429, 429], [500, 599]]);
    expect(retryConfig.httpMethodsToRetry).toContain("GET");
  });
});
