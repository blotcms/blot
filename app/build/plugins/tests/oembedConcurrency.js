// The oEmbed plugins look their links up concurrently and bound each lookup
// with a timeout. The flickr plugin stands for twitter and bluesky, which are
// written the same way.

describe("oEmbed plugins: timeouts and order", function () {
  const flickr = require("../flickr");
  const videoEmbeds = require("../videoEmbeds");
  const vimeo = require("../videoEmbeds/vimeo");
  const fetchWithTimeout = require("../fetchWithTimeout");
  const cheerio = require("cheerio");
  const nock = require("nock");

  global.test.timeout(10000);

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

  it("flickr: leaves the link as it was when the host does not answer in time", async function () {
    fetchWithTimeout.settings.timeout = 50;
    nock("https://www.flickr.com")
      .get("/services/oembed/")
      .query(true)
      .delay(1000)
      .reply(200, { html: "<i>embed</i>" });

    const $ = cheerio.load(
      '<a href="https://flic.kr/p/2quEvYr">https://flic.kr/p/2quEvYr</a>'
    );

    await flickr.render($, {});

    expect($("a[href='https://flic.kr/p/2quEvYr']").length).toBe(1);
    expect($("i").length).toBe(0);
  });

  it("flickr: keeps the embeds in the order of the links when lookups finish out of order", async function () {
    for (const [id, delay] of [
      ["aaa", 150],
      ["bbb", 10],
      ["ccc", 80],
    ]) {
      nock("https://www.flickr.com")
        .get("/services/oembed/")
        .query((q) => q.url === "https://flic.kr/p/" + id)
        .delay(delay)
        .reply(200, { html: "<i>" + id + "</i>" });
    }

    const $ = cheerio.load(
      ["aaa", "bbb", "ccc"]
        .map(
          (id) =>
            `<p><a href="https://flic.kr/p/${id}">https://flic.kr/p/${id}</a></p>`
        )
        .join("")
    );

    await flickr.render($, {});

    expect(
      $("i")
        .map((i, el) => $(el).text())
        .get()
    ).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("vimeo: rejects when Vimeo does not answer in time", async function () {
    fetchWithTimeout.settings.timeout = 50;
    nock("https://vimeo.com")
      .get("/api/oembed.json")
      .query(true)
      .delay(1000)
      .reply(200, { video_id: 1, width: 640, height: 360 });

    let error;

    try {
      await vimeo("https://vimeo.com/87952436");
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
  });

  it("video embeds: places the players in the order of the links", async function () {
    // The first video's lookup finishes last
    for (const [id, delay] of [
      ["111", 120],
      ["222", 5],
    ]) {
      nock("https://vimeo.com")
        .get("/api/oembed.json")
        .query((q) => q.url === "https://vimeo.com/" + id)
        .delay(delay)
        .reply(200, { video_id: id, width: 640, height: 360 });
    }

    const $ = cheerio.load(
      '<p>See <a href="https://vimeo.com/111">https://vimeo.com/111</a> and <a href="https://vimeo.com/222">https://vimeo.com/222</a></p>'
    );

    await videoEmbeds.render($, {});

    const ids = $("iframe")
      .map((i, el) => $(el).attr("src"))
      .get()
      .map((src) => src.match(/video\/(\d+)/)[1]);

    expect(ids).toEqual(["111", "222"]);
  });
});
