describe("scheduler host-memory", function () {
  const read = require("../host-memory");
  const fs = require("fs-extra");
  const os = require("os");
  const path = require("path");

  const MEMINFO = [
    "MemTotal:       16384000 kB",
    "MemFree:          200000 kB",
    "MemAvailable:    8192000 kB",
    "Buffers:          100000 kB",
    "",
  ].join("\n");

  it("reads MemTotal and MemAvailable, not MemFree, in bytes", function () {
    expect(read.parse(MEMINFO)).toEqual({
      total: 16384000 * 1024,
      available: 8192000 * 1024,
    });
  });

  it("is null without either field", function () {
    expect(read.parse("MemTotal: 1000 kB\n")).toBe(null);
    expect(read.parse("MemAvailable: 1000 kB\n")).toBe(null);
    expect(read.parse("")).toBe(null);
  });

  it("reads a file, and is null where there is none", async function () {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meminfo-"));

    try {
      await fs.writeFile(path.join(dir, "meminfo"), MEMINFO);
      expect(await read(path.join(dir, "meminfo"))).toEqual({
        total: 16384000 * 1024,
        available: 8192000 * 1024,
      });
      expect(await read(path.join(dir, "missing"))).toBe(null);
    } finally {
      await fs.remove(dir);
    }
  });

  it("agrees with os.freemem() where /proc/meminfo exists", async function () {
    const actual = await read();
    if (!actual) return;

    // Both read MemAvailable, so only what changes in between separates them
    expect(Math.abs(os.freemem() - actual.available)).toBeLessThan(
      0.1 * actual.total
    );
  });
});
