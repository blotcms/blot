const driveReaddir = require("../sync/util/driveReaddir");
const transformDriveItems = require("../sync/util/transformDriveItems");

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

  it("gives colliding names the same suffixes whatever order Drive lists them in", async function () {
    const listed = [
      { id: "b", name: "photo.jpg", mimeType: "image/jpeg" },
      { id: "c", name: "AC/DC.jpg", mimeType: "image/jpeg" },
      { id: "a", name: "photo.jpg", mimeType: "image/jpeg" },
      { id: "d", name: "AC_DC.jpg", mimeType: "image/jpeg" },
    ];
    const localNames = async (files) => {
      const drive = { files: { list: async () => ({ data: { files } }) } };
      const items = transformDriveItems(await driveReaddir(drive, "folder"));
      return Object.fromEntries(items.map((item) => [item.id, item.name]));
    };

    const forwards = await localNames(listed.map((item) => ({ ...item })));
    const backwards = await localNames(listed.map((item) => ({ ...item })).reverse());

    expect(forwards).toEqual({
      a: "photo.jpg",
      b: "photo (1).jpg",
      c: "AC_DC (1).jpg",
      d: "AC_DC.jpg",
    });
    expect(backwards).toEqual(forwards);
  });
});
