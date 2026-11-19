describe("fetchWithTimeout", function () {
  const fetchWithTimeout = require("../fetchWithTimeout");
  const nock = require("nock");

  let original;

  beforeEach(function () {
    nock.disableNetConnect();
    original = fetchWithTimeout.settings.timeout;
  });

  afterEach(function () {
    fetchWithTimeout.settings.timeout = original;
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("allows a host ten seconds", function () {
    expect(original).toBe(10 * 1000);
  });

  it("rejects when the host does not answer in time", async function () {
    fetchWithTimeout.settings.timeout = 50;
    nock("https://slow.example").get("/oembed").delay(1000).reply(200, {});

    let error;

    try {
      await fetchWithTimeout("https://slow.example/oembed");
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.type).toBe("request-timeout");
  });

  it("returns the response from a host that answers", async function () {
    nock("https://fast.example").get("/oembed").reply(200, { html: "<b></b>" });

    const res = await fetchWithTimeout("https://fast.example/oembed");

    expect(await res.json()).toEqual({ html: "<b></b>" });
  });
});
