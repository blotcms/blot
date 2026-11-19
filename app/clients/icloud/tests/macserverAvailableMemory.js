// The macserver's /stats reports available memory from vm_stat, as Activity
// Monitor does, since os.freemem() is close to nothing on macOS.
const path = require("path");
const { pathToFileURL } = require("url");

describe("icloud macserver availableMemory", function () {
  let parseVmStat;

  beforeAll(async function () {
    ({ parseVmStat } = await import(
      pathToFileURL(
        path.join(__dirname, "../macserver/util/availableMemory.js")
      ).href
    ));
  });

  const GB = 1024 * 1024 * 1024;
  const PAGE = 16384;
  // 1 GB of pages
  const P = GB / PAGE;

  const vmStat = ({ anonymous, purgeable, wired, compressor }) =>
    [
      `Mach Virtual Memory Statistics: (page size of ${PAGE} bytes)`,
      "Pages free:                                4536.",
      "Pages active:                            162268.",
      "Pages inactive:                          160139.",
      "Pages speculative:                         1276.",
      `Pages wired down:                        ${wired * P}.`,
      `Pages purgeable:                         ${purgeable * P}.`,
      "File-backed pages:                        88016.",
      `Anonymous pages:                         ${anonymous * P}.`,
      "Pages stored in compressor:             1193451.",
      `Pages occupied by compressor:            ${compressor * P}.`,
    ].join("\n");

  it("is total memory less app, wired and compressed memory", function () {
    const stdout = vmStat({
      anonymous: 5,
      purgeable: 1,
      wired: 2,
      compressor: 1,
    });

    expect(parseVmStat(stdout, 16 * GB)).toBe(9 * GB);
  });

  it("stays between none and the total", function () {
    const stdout = vmStat({
      anonymous: 20,
      purgeable: 0,
      wired: 2,
      compressor: 1,
    });

    expect(parseVmStat(stdout, 16 * GB)).toBe(0);
  });

  it("throws on output it doesn't recognise", function () {
    expect(() => parseVmStat("nothing here", 16 * GB)).toThrowError(
      /page size/
    );
    expect(() =>
      parseVmStat("(page size of 16384 bytes)\nPages free: 1.", 16 * GB)
    ).toThrowError(/Anonymous pages/);
  });
});
