describe("removeDiacritics", function () {
  const removeDiacritics = require("helper/removeDiacritics");

  it("returns empty string for empty input", function () {
    expect(removeDiacritics("")).toBe("");
  });

  it("returns empty string for null or undefined", function () {
    expect(removeDiacritics(null)).toBe("");
    expect(removeDiacritics(undefined)).toBe("");
  });

  it("converts to lowercase", function () {
    expect(removeDiacritics("HELLO")).toBe("hello");
    expect(removeDiacritics("HeLLo")).toBe("hello");
  });

  it("removes accents from common characters", function () {
    expect(removeDiacritics("café")).toBe("cafe");
    expect(removeDiacritics("résumé")).toBe("resume");
    expect(removeDiacritics("naïve")).toBe("naive");
  });

  it("handles French special characters", function () {
    expect(removeDiacritics("français")).toBe("francais");
    expect(removeDiacritics("garçon")).toBe("garcon");
  });

  it("handles German special characters", function () {
    expect(removeDiacritics("ü")).toBe("ue");
    expect(removeDiacritics("ö")).toBe("oe");
    expect(removeDiacritics("ä")).toBe("ae");
    expect(removeDiacritics("ß")).toBe("ss");
  });

  it("handles Nordic special characters", function () {
    expect(removeDiacritics("å")).toBe("aa");
    expect(removeDiacritics("æ")).toBe("ae");
    expect(removeDiacritics("ø")).toBe("o");
  });

  it("handles ligatures", function () {
    expect(removeDiacritics("œ")).toBe("oe");
  });

  it("handles Icelandic special characters", function () {
    expect(removeDiacritics("þ")).toBe("th");
  });

  it("preserves regular ASCII characters", function () {
    expect(removeDiacritics("hello")).toBe("hello");
    expect(removeDiacritics("world")).toBe("world");
  });

  it("handles mixed content", function () {
    expect(removeDiacritics("Héllo Wörld")).toBe("hello%20woerld");
  });

  it("handles Spanish special characters", function () {
    expect(removeDiacritics("niño")).toBe("nino");
    expect(removeDiacritics("señor")).toBe("senor");
  });

  it("handles Polish special characters", function () {
    expect(removeDiacritics("łódź")).toBe("lodz");
  });

  it("encodes the result as URI", function () {
    const result = removeDiacritics("hello world");
    expect(result).toBe("hello%20world");
  });
});
