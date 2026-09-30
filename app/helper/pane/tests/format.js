const { formatSize, formatDate, formatFolderSize, hash, invent } = require("../lib/format");

describe("pane format", function () {
  it("switches units at 1000 (Finder, GNOME) and 1024 (Explorer)", function () {
    expect(formatSize(999, "mac")).toBe("999 bytes");
    expect(formatSize(1000, "mac")).toBe("1 KB");
    expect(formatSize(1001, "linux")).toBe("1.0 kB");
    expect(formatSize(1023, "win")).toBe("1,023 bytes".replace(",", ""));
    expect(formatSize(1024, "win")).toBe("1 KB");
    expect(formatSize(1025, "win")).toBe("2 KB");
    expect(formatSize(0, "mac")).toBe("0 bytes");
    expect(formatSize(1, "win")).toBe("1 byte");
    expect(formatSize(1200000, "mac")).toBe("1.2 MB");
  });

  it("formats folder sizes per OS", function () {
    expect(formatFolderSize(0, "linux")).toBe("0 items");
    expect(formatFolderSize(1, "linux")).toBe("1 item");
    expect(formatFolderSize(2, "mac")).toBe("--");
    expect(formatFolderSize(2, "win")).toBe("");
  });

  it("formats dates: today as a time on macOS and GNOME, midnight and noon as 12", function () {
    const now = "2026-09-20T15:38:00";
    expect(formatDate("2026-09-20T00:05:00", "mac", now)).toBe("12:05 AM");
    expect(formatDate("2026-09-20T12:00:00", "mac", now)).toBe("12:00 PM");
    expect(formatDate("2026-09-20T13:07:00", "win", now)).toBe("9/20/2026 1:07 PM");
    expect(formatDate("2026-09-20T09:05:00", "linux", now)).toBe("Today 9:05");
    expect(formatDate("2025-02-05T14:46:00", "mac", now)).toBe("2/5/25");
    expect(formatDate("2025-02-05T14:46:00", "linux", now)).toBe("5 Feb 2025");
  });

  it("invents stable values that do not depend on the clock", function () {
    const a = invent("Fruits/Apple.md", "2026-09-20T15:38:00");
    expect(invent("Fruits/Apple.md", "2026-09-20T15:38:00")).toEqual(a);
    expect(invent("Fruits/Pear.md", "2026-09-20T15:38:00")).not.toEqual(a);
    expect(a.modified < "2026-09-20T15:38:00").toBe(true);
    expect(a.bytes).toBeGreaterThan(0);
    expect(hash("a")).toBe(hash("a"));
  });
});
