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

  it("removes trailing slashes and replaces other slashes in names", async function () {
    const drive = {
      files: {
        list: async () => ({
          data: {
            files: [
              { id: "1", name: "_images/" },
              { id: "2", name: "AC/DC.jpg" },
              { id: "3", name: "/" },
            ],
          },
        }),
      },
    };

    const items = await driveReaddir(drive, "folder");

    expect(items.map((item) => item.name)).toEqual(["_images", "AC_DC.jpg", "_"]);
  });
});
