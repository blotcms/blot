describe("video-embed plugin", function () {
  const videoEmbed = require("../index");
  const cheerio = require("cheerio");
  const nock = require("nock");
  const bandcampOgHtml = ({ src, width, height }) => `<!doctype html>
    <html>
      <head>
        <meta property="og:video" content="${src}">
        <meta property="og:video:width" content="${width}">
        <meta property="og:video:height" content="${height}">
      </head>
      <body></body>
    </html>`;

  beforeEach(function () {
    nock.disableNetConnect();

    nock("https://vimeo.com")
      .get("/api/oembed.json")
      .query(true)
      .reply(function (uri) {
        const requestUrl = new URL(`https://vimeo.com${uri}`).searchParams.get(
          "url"
        );

        if (requestUrl && requestUrl.startsWith("https://vimeo.com/87952436")) {
          return [
            200,
            {
              video_id: 87952436,
              width: 640,
              height: 360,
              thumbnail_url:
                "https://i.vimeocdn.com/video/466717816-33ad450eea4c71be9149dbe2e0d18673874917cadd5f1af29de3731e4d22a77f-d_295x166?region=us",
            },
          ];
        }

        return [404, { error: "Not found" }];
      });
  });

  afterEach(function () {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("embeds videos from youtube, vimeo and music from bandcamp", async function () {
    nock("https://oliviachaney.bandcamp.com")
      .get("/album/circus-of-desire")
      .reply(
        200,
        bandcampOgHtml({
          src: "https://bandcamp.com/EmbeddedPlayer/v=2/album=2447688282/size=large/tracklist=false/artwork=small/",
          width: 400,
          height: 120,
        })
      );
    nock("https://cloquet.bandcamp.com")
      .get("/track/new-drugs")
      .reply(
        200,
        bandcampOgHtml({
          src: "https://bandcamp.com/EmbeddedPlayer/v=2/track=2483181576/size=large/tracklist=false/artwork=small/",
          width: 400,
          height: 120,
        })
      );
    const $ = cheerio.load(
      `<a href="https://www.youtube.com/watch?v=MJ62hh0a9U4">https://www.youtube.com/watch?v=MJ62hh0a9U4</a>
        <a href="https://vimeo.com/87952436">https://vimeo.com/87952436</a>
        <a href="https://oliviachaney.bandcamp.com/album/circus-of-desire">https://oliviachaney.bandcamp.com/album/circus-of-desire</a>
        <a href="https://cloquet.bandcamp.com/track/new-drugs">https://cloquet.bandcamp.com/track/new-drugs</a>
        <a href="https://foo.com/87952436">https://foo.com/87952436</a>
      `,
      { decodeEntities: false },
      false
    );
    await videoEmbed.render($, {});
    expect($("iframe").length).toEqual(4);
  });
  it("flags a video it could not embed, but not a link to a channel or an artist", async function () {
    const { collect } = require("build/flags");
    const links = [
      "https://www.youtube.com/@example",
      "https://www.youtube.com/playlist?list=PL123",
      "https://example.bandcamp.com/music",
      "https://vimeo.com/someone",
      "https://vimeo.com/12345",
    ];
    const $ = cheerio.load(
      links.map((href) => `<a href="${href}">${href}</a>`).join("\n")
    );

    const { flags } = await collect(() => videoEmbed.render($, {}));

    expect(flags).toEqual([
      { code: "EMBED_FAILED", targets: ["https://vimeo.com/12345"] },
    ]);
    expect($("a").length).toEqual(links.length);
  });
});
