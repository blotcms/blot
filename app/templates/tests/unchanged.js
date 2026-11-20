describe("built-in templates", function () {
  const Template = require("models/template");
  const templates = require("templates");
  const fs = require("fs-extra");

  // Template names are the folders of app/templates/source
  const ids = fs
    .readdirSync(__dirname + "/../source")
    .filter((name) => name[0] !== "." && name.toLowerCase() !== "readme")
    .map((name) => "SITE:" + name);

  async function read() {
    const result = {};

    for (const id of ids) {
      const { views, metadata } = await Template.getAllViews(id);
      result[id] = { cacheID: metadata.cacheID, views };
    }

    return result;
  }

  it("keep their cacheID and views when built again unchanged", async function () {
    await templates({});

    const before = await read();

    await templates({});

    const after = await read();

    ids.forEach((id) => {
      expect(Object.keys(before[id].views).length).toBeGreaterThan(0);
      expect(after[id].cacheID).toEqual(before[id].cacheID);
      expect(after[id].views).toEqual(before[id].views);
    });
  });
});
