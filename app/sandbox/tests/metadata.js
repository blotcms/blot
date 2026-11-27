describe("sandbox metadata job", function () {
  const sharp = require("sharp");
  const fs = require("fs-extra");
  const os = require("os");
  const path = require("path");
  const config = require("config");
  const sandbox = require("../");

  let socket;

  beforeEach(function () {
    // no broker: the job runs in-process
    socket = config.sandbox.socket;
    config.sandbox.socket = "";
  });

  afterEach(function () {
    config.sandbox.socket = socket;
  });

  async function image() {
    return sharp({
      create: { width: 20, height: 10, channels: 4, background: "#fff" },
    })
      .png()
      .toBuffer();
  }

  it("refuses an image of more than 100 million pixels", async function () {
    const input = await sharp({
      create: { width: 10001, height: 10001, channels: 3, background: "#fff" },
    })
      .png({ palette: true, colours: 2, compressionLevel: 9 })
      .toBuffer();
    let error = null;
    try {
      await sandbox.run("metadata", {}, input);
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeNull();
  });

  it("reads an image from a buffer", async function () {
    const { meta, outputs } = await sandbox.run("metadata", {}, await image());

    expect(outputs).toEqual([]);
    expect(meta).toEqual({
      format: "png",
      width: 20,
      height: 10,
      pages: undefined,
      orientation: undefined,
      hasAlpha: true,
    });
  });

  it("reads an image from a path", async function () {
    const file = path.join(
      os.tmpdir(),
      "sandbox-metadata-" + Date.now() + ".png"
    );
    await fs.outputFile(file, await image());

    try {
      const { meta } = await sandbox.run("metadata", {}, { path: file });
      expect(meta.width).toEqual(20);
      expect(meta.height).toEqual(10);
    } finally {
      await fs.remove(file);
    }
  });

  it("rejects bytes that are not an image", async function () {
    let error;
    try {
      await sandbox.run("metadata", {}, Buffer.from("not an image"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
  });

  it("rejects a job it does not know", async function () {
    let error;
    try {
      await sandbox.run("../metadata", {}, Buffer.alloc(0));
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
  });
});
