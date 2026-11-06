describe("youtube embeds", function () {
  const youtube = require("../youtube");

  it("handles an empty href", function (done) {
    const href = "";
    youtube(href, (err, template) => {
      expect(err.message).toEqual("Could not parse youtube video");
      expect(template).toEqual(undefined);
      done();
    });
  });

  it("handles an invalid href", function (done) {
    const href = "https://www.youtube.com/watch?v=";
    youtube(href, (err, template) => {
      expect(err.message).toEqual("Could not parse youtube video");
      expect(template).toEqual(undefined);
      done();
    });
  });

  it("handles an invalid host", function (done) {
    const href = "https://www.youtubee.com/watch?v=123";
    youtube(href, (err, template) => {
      expect(err.message).toEqual("Could not parse youtube video");
      expect(template).toEqual(undefined);
      done();
    });
  });

  it("handles a valid link", function (done) {
    const href = "https://www.youtube.com/watch?v=YaT_5KoGh1Q";
    youtube(href, (err, template) => {
      expect(err).toEqual(null);
      expect(template).toEqual(
        `<div style="width:0;height:0"> </div><div class="videoContainer" style="padding-bottom:56.25%"><iframe src="https://www.youtube-nocookie.com/embed/YaT_5KoGh1Q?rel=0&wmode=transparent&rel=0&autohide=1&showinfo=0" frameborder="0" allowfullscreen></iframe></div>`
      );
      done();
    });
  });
});
