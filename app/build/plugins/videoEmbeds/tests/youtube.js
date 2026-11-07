describe("youtube embeds", function () {
  const youtube = require("../youtube");

  it("handles an empty href", async function () {
    const href = "";
    let err, template;
    try {
      template = await youtube(href);
    } catch (e) {
      err = e;
    }
    expect(err.message).toEqual("Could not parse youtube video");
    expect(template).toEqual(undefined);
  });

  it("handles an invalid href", async function () {
    const href = "https://www.youtube.com/watch?v=";
    let err, template;
    try {
      template = await youtube(href);
    } catch (e) {
      err = e;
    }
    expect(err.message).toEqual("Could not parse youtube video");
    expect(template).toEqual(undefined);
  });

  it("handles an invalid host", async function () {
    const href = "https://www.youtubee.com/watch?v=123";
    let err, template;
    try {
      template = await youtube(href);
    } catch (e) {
      err = e;
    }
    expect(err.message).toEqual("Could not parse youtube video");
    expect(template).toEqual(undefined);
  });

  it("handles a valid link", async function () {
    const href = "https://www.youtube.com/watch?v=YaT_5KoGh1Q";
    let err, template;
    try {
      template = await youtube(href);
    } catch (e) {
      err = e;
    }
    expect(err).toBeUndefined();
    expect(template).toEqual(
      `<div style="width:0;height:0"> </div><div class="videoContainer" style="padding-bottom:56.25%"><iframe src="https://www.youtube-nocookie.com/embed/YaT_5KoGh1Q?rel=0&wmode=transparent&rel=0&autohide=1&showinfo=0" frameborder="0" allowfullscreen></iframe></div>`
    );
  });
});
