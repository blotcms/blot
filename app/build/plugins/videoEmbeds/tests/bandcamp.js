describe("bandcamp embeds", function () {
  const bandcamp = require("../bandcamp");
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
  });

  afterEach(function () {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it("handles an empty href", function (done) {
    const href = "";
    bandcamp(href, (err, template) => {
      expect(err.message).toEqual("Could not retrieve song properties");
      expect(template).toEqual(undefined);
      done();
    });
  });

  it("handles an invalid href", function (done) {
    const href = "https://bandcamp.com";
    bandcamp(href, (err, template) => {
      expect(err.message).toEqual("Could not retrieve song properties");
      expect(template).toEqual(undefined);
      done();
    });
  });

  it("handles an invalid path", function (done) {
    const href = "https://bandcamp.com/invalid";
    bandcamp(href, (err, template) => {
      expect(err.message).toEqual("Could not retrieve song properties");
      expect(template).toEqual(undefined);
      done();
    });
  });

  it("handles a valid link to an album on a bandcamp subdomain", function (done) {
    const href = "https://oliviachaney.bandcamp.com/album/circus-of-desire";
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
    bandcamp(href, (err, template) => {
      expect(err).toEqual(null);
      expect(template).toEqual(
        `<div style="width:0;height:0"> </div><div class="videoContainer bandcamp" style="padding-bottom: 120px"><iframe width="400" height="120" src="https://bandcamp.com/EmbeddedPlayer/v=2/album=2447688282/size=large/tracklist=false/artwork=small/" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe></div>`
      );
      done();
    });
  });

  ["https://notbandcamp.com/album/x", "https://evil-bandcamp.com/track/y"].forEach(
    (href) => {
      it("refuses look-alike host " + href, function (done) {
        // No nock set up: if the plugin tried to fetch this it would throw
        // on the disabled net connection, not return ERROR_MESSAGE.
        bandcamp(href, (err, template) => {
          expect(err.message).toEqual("Could not retrieve song properties");
          expect(template).toEqual(undefined);
          done();
        });
      });
    }
  );

  it("does not follow a redirect off bandcamp", function (done) {
    nock("https://oliviachaney.bandcamp.com")
      .get("/album/circus-of-desire")
      .reply(302, "", { Location: "http://169.254.169.254/latest/meta-data/" });
    // nock.disableNetConnect() means a request to the Location would throw.
    bandcamp(
      "https://oliviachaney.bandcamp.com/album/circus-of-desire",
      (err, template) => {
        expect(err.message).toEqual("Could not retrieve song properties");
        expect(template).toEqual(undefined);
        done();
      }
    );
  });

  it("fetches the rebuilt https URL, not the raw href", function (done) {
    // Credentials + explicit port + query string in the href must not reach
    // the network - only https://<host>/<path> is fetched.
    nock("https://oliviachaney.bandcamp.com")
      .get("/album/circus-of-desire")
      .reply(
        200,
        bandcampOgHtml({
          src: "https://bandcamp.com/EmbeddedPlayer/v=2/album=1/size=large/",
          width: 400,
          height: 120,
        })
      );
    bandcamp(
      "https://user:pw@oliviachaney.bandcamp.com:8443/album/circus-of-desire?foo=bar",
      (err, template) => {
        expect(err).toEqual(null);
        expect(template).toContain("bandcamp.com/EmbeddedPlayer");
        done();
      }
    );
  });

  it("handles a valid link to a track on a bandcamp subdomain", function (done) {
    const href = "https://cloquet.bandcamp.com/track/new-drugs";
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
    bandcamp(href, (err, template) => {
      expect(err).toEqual(null);
      expect(template).toEqual(
        `<div style="width:0;height:0"> </div><div class="videoContainer bandcamp" style="padding-bottom: 120px"><iframe width="400" height="120" src="https://bandcamp.com/EmbeddedPlayer/v=2/track=2483181576/size=large/tracklist=false/artwork=small/" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe></div>`
      );
      done();
    });
  });

  // The page is parsed in the sandbox's fetch job (sandbox/jobs/html.js), which
  // returns a validated player address and size, never the page
  describe("a page that is not what it should be", function () {
    const href = "https://oliviachaney.bandcamp.com/album/circus-of-desire";
    const reply = (body) => nock("https://oliviachaney.bandcamp.com").get("/album/circus-of-desire").reply(200, body);
    const refused = (done) => (err, template) => {
      expect(err.message).toEqual("Could not retrieve song properties");
      expect(template).toEqual(undefined);
      done();
    };

    it("refuses a player address that is not http(s)", function (done) {
      reply(bandcampOgHtml({ src: "javascript:alert(1)", width: 400, height: 120 }));
      bandcamp(href, refused(done));
    });

    it("refuses a player address that would break out of the attribute", function (done) {
      reply(bandcampOgHtml({ src: "https://bandcamp.com/x&quot; onload=&quot;alert(1)", width: 400, height: 120 }));
      bandcamp(href, refused(done));
    });

    it("refuses a size that is not a number of pixels", function (done) {
      reply(bandcampOgHtml({ src: "https://bandcamp.com/EmbeddedPlayer/", width: "400px", height: "120;x" }));
      bandcamp(href, refused(done));
    });

    it("refuses a page with no player", function (done) {
      reply("<!doctype html><html><head><title>x</title></head><body></body></html>");
      bandcamp(href, refused(done));
    });

    it("refuses a page nested too deeply to parse, and one with too many tags", function (done) {
      reply(bandcampOgHtml({ src: "https://bandcamp.com/EmbeddedPlayer/", width: 400, height: 120 }) + "<div>".repeat(29000));
      bandcamp(href, function (err, template) {
        expect(err.message).toEqual("Could not retrieve song properties");
        expect(template).toEqual(undefined);
        reply("<a></a>".repeat(30000));
        bandcamp(href, refused(done));
      });
    });

    it("reads the player from the head of a page too long to read whole", function (done) {
      reply(bandcampOgHtml({ src: "https://bandcamp.com/EmbeddedPlayer/v=2/album=1/", width: 400, height: 120 }) + "x".repeat(3 * 1024 * 1024));
      bandcamp(href, function (err, template) {
        expect(err).toEqual(null);
        expect(template).toContain('src="https://bandcamp.com/EmbeddedPlayer/v=2/album=1/"');
        done();
      });
    });
  });
});
