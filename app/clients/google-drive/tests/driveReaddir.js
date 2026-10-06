const driveReaddir = require("../sync/util/driveReaddir");

describe("Drive readdir", function () {
  it("normalizes names to NFC so they match the paths localPath writes", async function () {
    const nfd = "à propos.md".normalize("NFD");
    const drive = {
      files: {
        list: async () => ({ data: { files: [{ id: "1", name: nfd }] } }),
      },
    };

    const [item] = await driveReaddir(drive, "folder");

    expect(nfd).not.toBe("à propos.md".normalize("NFC"));
    expect(item.name).toBe("à propos.md".normalize("NFC"));
  });
});
