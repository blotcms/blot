const normalizeIdentifier = require("../normalize_identifier");

describe("import identifier normalization", function () {
  it("strips POSIX and Windows path components", function () {
    expect(normalizeIdentifier("../../exports/site.xml", { extension: ".xml" })).toBe("site");
    expect(normalizeIdentifier("C:\\Users\\name\\site.xml", { extension: ".xml" })).toBe("site");
  });

  it("rejects dot segments and empty names with source-specific fallbacks", function () {
    expect(normalizeIdentifier("../..", { fallback: "Blogger export" })).toBe(
      "Blogger export"
    );
    expect(
      normalizeIdentifier(".xml", {
        extension: ".xml",
        fallback: "WordPress export",
      })
    ).toBe("WordPress export");
    expect(normalizeIdentifier("CON", { fallback: "Are.na channel" })).toBe(
      "Are.na channel"
    );
    expect(normalizeIdentifier("", { fallback: "Are.na channel" })).toBe(
      "Are.na channel"
    );
  });

  it("removes controls and characters unsafe in HTML, headers, files, and ZIP names", function () {
    const result = normalizeIdentifier("bad\r\n<name>&\"'`:*?|.xml", {
      extension: ".xml",
    });

    expect(result).toBe("badname");
    // eslint-disable-next-line no-control-regex
    expect(result).not.toMatch(/[\u0000-\u001f\u007f-\u009f<>:"'`&/\\|?*]/);
  });

  it("preserves and normalizes Unicode without splitting code points", function () {
    expect(normalizeIdentifier("Cafe\u0301-東京.xml", { extension: ".xml" })).toBe("Café-東京");

    const result = normalizeIdentifier("😀".repeat(100));
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
      normalizeIdentifier.MAX_BYTES
    );
    expect(Array.from(result).length).toBe(60);
  });

  it("limits long ASCII names by characters and bytes", function () {
    const result = normalizeIdentifier("a".repeat(500) + ".atom", {
      extension: ".atom",
    });

    expect(result).toBe("a".repeat(normalizeIdentifier.MAX_CHARACTERS));
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
      normalizeIdentifier.MAX_BYTES
    );
  });

  it("removes only the configured source export extension", function () {
    expect(
      normalizeIdentifier("wordpress.2026-08-08.xml", { extension: ".xml" })
    ).toBe("wordpress.2026-08-08");
    expect(
      normalizeIdentifier("blogger-export.ATOM", { extension: ".atom" })
    ).toBe("blogger-export");
    expect(normalizeIdentifier("notes.txt", { extension: ".xml" })).toBe("notes.txt");
  });
});
