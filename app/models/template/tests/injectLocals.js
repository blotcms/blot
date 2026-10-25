const config = require("config");
const injectLocals = require("../injectLocals");

describe("injectLocals", function () {
  it("populates a font local's styles from just an id", function () {
    const locals = { font: { id: "geist" } };

    injectLocals(locals);

    expect(locals.font.name).toEqual("Geist");
    expect(locals.font.styles).toContain("@font-face");
    // Mustache-rendered with the real CDN origin, not the raw token
    expect(locals.font.styles).toContain(config.cdn.origin);
    expect(locals.font.styles).not.toContain("{{{config.cdn.origin}}}");
  });

  it("emits only .woff2 and .woff sources after the format migration", function () {
    const locals = { body_font: { id: "geist" } };

    injectLocals(locals);

    expect(locals.body_font.styles).toContain("format('woff2')");
    expect(locals.body_font.styles).toContain("format('woff')");
    expect(locals.body_font.styles).not.toMatch(/\.(eot|ttf|otf|svg)\b/);
    expect(locals.body_font.styles).not.toContain("embedded-opentype");
    expect(locals.body_font.styles).not.toContain("iefix");
  });

  it("overwrites protected props (styles/name/stack) from the registry", function () {
    const locals = {
      title_font: {
        id: "geist",
        name: "Stale Name",
        stack: "'Stale Stack'",
        styles: "@font-face{src:url('/fonts/geist/regular.ttf')}",
      },
    };

    injectLocals(locals);

    expect(locals.title_font.name).toEqual("Geist");
    expect(locals.title_font.stack).not.toEqual("'Stale Stack'");
    expect(locals.title_font.styles).not.toContain(".ttf");
  });

  it("keeps non-protected props already set on the local", function () {
    const locals = { font: { id: "geist", line_height: 9.9 } };

    injectLocals(locals);

    expect(locals.font.line_height).toEqual(9.9);
  });

  it("leaves an unknown font id untouched and does not throw", function () {
    const locals = { font: { id: "not-a-real-font" } };

    expect(function () {
      injectLocals(locals);
    }).not.toThrow();

    expect(locals.font).toEqual({ id: "not-a-real-font" });
  });

  it("ignores locals that are not font or *_font keys", function () {
    const locals = { page_size: 20, heading: { id: "geist" } };

    injectLocals(locals);

    expect(locals.heading).toEqual({ id: "geist" });
    expect(locals.page_size).toEqual(20);
  });

  describe("stale font styles stored in template metadata", function () {
    const stale =
      "@font-face{font-family:'Plex Mono';src:url({{{config.cdn.origin}}}/fonts/plex-mono/thin.eot?version=1&extension=.eot);src:url({{{config.cdn.origin}}}/fonts/plex-mono/thin.ttf?version=1&extension=.ttf) format('truetype')}";

    it("re-renders a stale verbatim copy of the old registry CSS", function () {
      const locals = {
        font: { id: "plex-mono", name: "Plex Mono", styles: stale },
      };

      injectLocals(locals);

      expect(locals.font.styles).not.toContain("{{");
      expect(locals.font.styles).not.toMatch(/\.(eot|ttf|otf)\b/);
      expect(locals.font.styles).toContain("woff2");
    });

    it("refresh-font-styles reports changes, unknown fonts, and is idempotent", function () {
      const { refreshLocals } = require("../../../../scripts/template/refresh-font-styles");
      const locals = {
        font: { id: "plex-mono", name: "Plex Mono", styles: stale },
        title_font: { id: "not-a-real-font", styles: "x" },
        page_size: 20,
      };
      const original = JSON.stringify(locals);

      const first = refreshLocals(locals);

      expect(JSON.stringify(locals)).toEqual(original); // input untouched
      expect(first.changed).toBe(true);
      expect(first.locals.font.styles).not.toContain("{{");
      expect(first.unknown).toEqual([
        { key: "title_font", fontID: "not-a-real-font" },
      ]);
      expect(first.unrendered).toEqual([]);

      const second = refreshLocals(first.locals);
      expect(second.changed).toBe(false);
    });
  });
});
