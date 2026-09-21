// The runner-OS guard and the new-image check (screenshots/check-os.js, check-runner-images.js).
const { observe, compare, message } = require("../screenshots/check-os");
const { newerLabels, newer } = require("../screenshots/check-runner-images");
const expected = require("../screenshots/os-versions.json");

describe("pane runner OS guard", function () {
  it("reads the visually relevant versions on each platform", function () {
    expect(observe("darwin", { sh: () => "26.6.2" })).toEqual({ os: "macos", version: "26.6" });
    expect(observe("win32", { release: "10.0.26100" })).toEqual({ os: "windows", build: "26100" });
    const sh = (cmd) => (cmd === "nautilus" ? "GNOME nautilus 46.4" : "1:1.5.0-1ubuntu1");
    expect(observe("linux", { sh, osRelease: 'NAME="Ubuntu"\nVERSION_ID="24.04"\n' })).toEqual({ os: "linux", release: "24.04", nautilus: "46", libadwaita: "1.5" });
    expect(observe("linux", { basic: true, sh, osRelease: 'VERSION_ID="24.04"' })).toEqual({ os: "linux", release: "24.04" });
  });

  it("passes on the recorded versions and ignores patch releases", function () {
    expect(compare(expected, { os: "macos", version: "26.6" })).toEqual([]);
    expect(compare(expected, observe("darwin", { sh: () => "26.6.9" }))).toEqual([]);
    expect(compare(expected, { os: "windows", build: "26100" })).toEqual([]);
  });

  it("reports every field that changed, and says where to go", function () {
    const diffs = compare(expected, { os: "linux", release: "26.04", nautilus: "50", libadwaita: "1.5" });
    expect(diffs.map((d) => d.field)).toEqual(["release", "nautilus"]);
    expect(message("linux", diffs)).toContain("UPDATING-OS.md");
    expect(message("linux", diffs)).toContain("Nautilus 46 expected, 50");
  });

  it("checks only the release/build in basic mode, and treats a missing tool as a mismatch otherwise", function () {
    expect(compare(expected, { os: "linux", release: "24.04" }, true)).toEqual([]);
    expect(compare(expected, { os: "linux", release: "24.04" }).map((d) => d.actual)).toEqual(["not found", "not found"]);
  });
});

describe("pane new runner image check", function () {
  const readme = "| macOS 27 | `macos-27` |\n| macOS 26 | `macos-26`, `macos-latest` | `macos-26-xlarge` | `macos-27-large` |\n| Windows Server 2025 | `windows-2025`, `windows-2025-vs2026` | `windows-11-arm` |\n| Ubuntu 26.04 | `ubuntu-26.04` | `ubuntu-26.04-arm` | Ubuntu 24.04 | `ubuntu-24.04` | `ubuntu-slim` |";

  it("compares versions numerically", function () {
    expect(newer([26, 4], [24, 4])).toBe(true);
    expect(newer([9], [26])).toBe(false);
    expect(newer([26, 4], [26, 4])).toBe(false);
  });

  it("finds only newer base-image labels", function () {
    expect(newerLabels(readme, expected)).toEqual([
      { family: "macos", pinned: "macos-26", newest: "macos-27" },
      { family: "linux", pinned: "ubuntu-24.04", newest: "ubuntu-26.04" },
    ]);
  });

  it("finds nothing when we are on the newest", function () {
    expect(newerLabels("`macos-26` `windows-2025` `ubuntu-24.04` `ubuntu-24.04-arm`", expected)).toEqual([]);
  });
});
