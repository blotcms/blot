describe("publishPreviewReload", function () {
  const helperPath = require.resolve("../publishPreviewReload");
  const clientPath = require.resolve("models/client");
  let originalClient;
  let originalHelper;

  beforeEach(function () {
    originalClient = require.cache[clientPath];
    originalHelper = require.cache[helperPath];
  });

  afterEach(function () {
    delete require.cache[helperPath];
    if (originalHelper) require.cache[helperPath] = originalHelper;
    else delete require.cache[helperPath];
    if (originalClient) require.cache[clientPath] = originalClient;
    else delete require.cache[clientPath];
  });

  function load(publish) {
    require.cache[clientPath] = { exports: { publish: publish } };
    delete require.cache[helperPath];
    return require("../publishPreviewReload");
  }

  it("publishes a reload on the blog's preview channel", async function () {
    const publish = jasmine.createSpy("publish").and.returnValue(Promise.resolve(1));
    const previewReload = load(publish);

    await previewReload.publish("blog_1");

    expect(previewReload.channel("blog_1")).toBe("blog:blog_1:preview:reload");
    expect(publish).toHaveBeenCalledWith("blog:blog_1:preview:reload", "reload");
  });

  it("does not publish without a blog id", async function () {
    const publish = jasmine.createSpy("publish").and.returnValue(Promise.resolve(1));
    const previewReload = load(publish);

    await previewReload.publish("");
    await previewReload.publish();
    await previewReload.publish("SITE");

    expect(publish).not.toHaveBeenCalled();
  });

  it("swallows a redis error so the save can still finish", async function () {
    const publish = jasmine
      .createSpy("publish")
      .and.returnValue(Promise.reject(new Error("down")));
    const previewReload = load(publish);

    await previewReload.publish("blog_1");

    expect(publish).toHaveBeenCalled();
  });
});
