describe("vimeo embeds", function () {
  const vimeo = require("../vimeo");
  const nock = require("nock");

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
  it("handles an empty href", async function () {
    const href = "";
    let err, template;
    try {
      template = await vimeo(href);
    } catch (e) {
      err = e;
    }
    expect(err.message).toEqual("Could not retrieve video properties");
    expect(template).toEqual(undefined);
  });

  it("handles an invalid href", async function () {
    const href = "https://vimeo.com/^*%&^*(";
    let err, template;
    try {
      template = await vimeo(href);
    } catch (e) {
      err = e;
    }
    expect(err.message).toEqual("Could not retrieve video properties");
    expect(template).toEqual(undefined);
  });

  it("handles an invalid host", async function () {
    const href = "https://viimeo.com/123";
    let err, template;
    try {
      template = await vimeo(href);
    } catch (e) {
      err = e;
    }
    expect(err.message).toEqual("Could not retrieve video properties");
    expect(template).toEqual(undefined);
  });

  it("handles an invalid path", async function () {
    const href = "https://vimeo.com/invalid";
    let err, template;
    try {
      template = await vimeo(href);
    } catch (e) {
      err = e;
    }
    expect(err.message).toEqual("Could not retrieve video properties");
    expect(template).toEqual(undefined);
  });

  it("handles a valid link", async function () {
    const href = "https://vimeo.com/87952436";
    let err, template;
    try {
      template = await vimeo(href);
    } catch (e) {
      err = e;
    }
    expect(err).toBeUndefined();
    expect(template).toEqual(
      `<div style="width:0;height:0"> </div><div class="videoContainer vimeo" style="padding-bottom: 56.25%" ><iframe data-thumbnail="https://i.vimeocdn.com/video/466717816-33ad450eea4c71be9149dbe2e0d18673874917cadd5f1af29de3731e4d22a77f-d.jpg" src="//player.vimeo.com/video/87952436?badge=0&color=ffffff&byline=0&portrait=0" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe></div>`
    );
  });

  it("handles a valid link with a trailing slash", async function () {
    const href = "https://vimeo.com/87952436/";
    let err, template;
    try {
      template = await vimeo(href);
    } catch (e) {
      err = e;
    }
    expect(err).toBeUndefined();
    expect(template).toEqual(
      `<div style="width:0;height:0"> </div><div class="videoContainer vimeo" style="padding-bottom: 56.25%" ><iframe data-thumbnail="https://i.vimeocdn.com/video/466717816-33ad450eea4c71be9149dbe2e0d18673874917cadd5f1af29de3731e4d22a77f-d.jpg" src="//player.vimeo.com/video/87952436?badge=0&color=ffffff&byline=0&portrait=0" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe></div>`
    );
  });

  it("handles a valid link with a query string", async function () {
    const href = "https://vimeo.com/87952436?query=string";
    let err, template;
    try {
      template = await vimeo(href);
    } catch (e) {
      err = e;
    }
    expect(err).toBeUndefined();
    expect(template).toEqual(
      `<div style="width:0;height:0"> </div><div class="videoContainer vimeo" style="padding-bottom: 56.25%" ><iframe data-thumbnail="https://i.vimeocdn.com/video/466717816-33ad450eea4c71be9149dbe2e0d18673874917cadd5f1af29de3731e4d22a77f-d.jpg" src="//player.vimeo.com/video/87952436?badge=0&color=ffffff&byline=0&portrait=0" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe></div>`
    );
  });

  it("handles a valid link with a hash", async function () {
    const href = "https://vimeo.com/87952436#hash";
    let err, template;
    try {
      template = await vimeo(href);
    } catch (e) {
      err = e;
    }
    expect(err).toBeUndefined();
    expect(template).toEqual(
      `<div style="width:0;height:0"> </div><div class="videoContainer vimeo" style="padding-bottom: 56.25%" ><iframe data-thumbnail="https://i.vimeocdn.com/video/466717816-33ad450eea4c71be9149dbe2e0d18673874917cadd5f1af29de3731e4d22a77f-d.jpg" src="//player.vimeo.com/video/87952436?badge=0&color=ffffff&byline=0&portrait=0" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe></div>`
    );
  });
});
