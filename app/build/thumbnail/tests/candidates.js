describe("candidates", function () {
  var candidates = require("../candidates");

  // metadata should be at top of queue
  // then the images in the html if there are any
  // in the order they appear in the post
  it("finds a thumbnail candidate", function () {
    var metadata = { thumbnail: "http://example.com/image-in-metadata.jpg" };
    var html = `<img src="/first-image.jpg">
      <div class="videoContainer" style="padding-bottom:56.25%"><iframe src="https://www.youtube.com/embed/YaT_5KoGh1Q?rel=0&wmode=transparent&rel=0&autohide=1&showinfo=0" frameborder="0" allowfullscreen></iframe></div>
      <img src="/second-image.jpg">`;

    expect(candidates(metadata, html)).toEqual([
      "http://example.com/image-in-metadata.jpg",
      "/first-image.jpg",
      "https://i.ytimg.com/vi/YaT_5KoGh1Q/maxresdefault.jpg",
      "http://img.youtube.com/vi/YaT_5KoGh1Q/mqdefault.jpg",
      "/second-image.jpg",
    ]);
  });

  it("uses mixed-case thumbnail metadata", function () {
    var metadata = { ThUmBnAiL: "http://example.com/mixed.jpg" };

    expect(candidates(metadata, "<p>Hello</p>")).toEqual([
      "http://example.com/mixed.jpg",
    ]);
  });

  it("does not find a thumbnail candidate", function () {
    var metadata = {};
    var html = "<p>Hello, World!</p>";

    expect(candidates(metadata, html)).toEqual([]);
  });
});
