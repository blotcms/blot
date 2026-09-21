const css = require("../lib/css");
const pane = require("../index");

describe("pane css build", function () {
  const skin = css.skin("mac", `
    @light{--bg:#fff;--fg:#111}
    @dark{--bg:#000;--fg:#eee}
    .pane{background:var(--bg)}
    .pane .pane-bar{color:var(--fg)}
    .pane::before{content:""}
  `);

  it("applies rules to windows following the visitor's OS and to pinned windows, never both", function () {
    const group = `:is(html[data-os=mac] .pane:not([data-pin]),.pane[data-pin=mac],${css.unbuilt(css.SKINS)} .pane:not([data-pin]))`;
    expect(skin).toContain(`${group} .pane-bar{color:var(--fg)}`);
    expect(skin).toContain(`${group}::before{content:""}`);
    // the visitor's-OS path excludes every pinned window
    expect(css.group("win")).toBe(":is(html[data-os=win] .pane:not([data-pin]),.pane[data-pin=win])");
  });

  it("generates the light block, the prefers-color-scheme block and the pinned dark block", function () {
    expect(skin).toMatch(/\{--bg:#fff;--fg:#111;color-scheme:light\}/);
    expect(skin).toMatch(/@media \(prefers-color-scheme:dark\)\{[^]*:not\(\[data-theme=light\]\)\{--bg:#000;--fg:#eee;color-scheme:dark\}\}/);
    expect(skin).toMatch(/\[data-theme=dark\]\{--bg:#000;--fg:#eee;color-scheme:dark\}$/);
  });

  it("refuses a selector that is not rooted at .pane", function () {
    expect(() => css.skin("mac", ".pane-bar{color:red}")).toThrowError(/must start with \.pane/);
  });

  it("expands dark-only rules under the same theme selectors", function () {
    const s = css.skin("mac", "@dark{--a:1;.pane .pane-icon{opacity:.5}}");
    expect(s.match(/pane-icon\{opacity:\.5\}/g).length).toBe(2);
  });

  it("minifies without touching calc()", function () {
    expect(css.minify("a { width: calc(1px + 2px); /* x */ color: red; }")).toBe("a{width:calc(1px + 2px);color:red}");
  });

  it("ships one stylesheet with inline SVG icons and no bitmaps", function () {
    const { css: out } = pane.assets();
    expect(out).toContain("data:image/svg+xml,");
    expect(out).not.toMatch(/\.png|image\/png|\.jpg/);
    expect(out).not.toContain("icon:");
    expect(out).not.toMatch(/@light|@dark/);
    expect(pane.assets().css).toBe(out);
  });

  it("is prepared for prefers-color-scheme, forced-colors and container queries", function () {
    const { css: out } = pane.assets();
    expect(out).toContain("@media (forced-colors:active)");
    expect(out).toContain("prefers-color-scheme:dark");
    expect(out).toContain("container-type:inline-size");
  });
});

describe("pane skins spanning several css files", function () {
  const fs = require("fs");
  const path = require("path");
  const dir = path.join(__dirname, "..", "css");
  const part = path.join(dir, "mac-zzpart.css");

  afterEach(function () {
    fs.rmSync(part, { force: true });
  });

  it("read css/<os>-<part>.css as part of the same skin, wrapped like the rest", function () {
    fs.writeFileSync(part, "@light{--zz:#123}\n.pane .zz-only{color:var(--zz)}\n");
    const built = css.build({ skins: ["mac"] });
    expect(built).toContain("--zz:#123");
    expect(built).toContain(`${css.group("mac", ["mac"])} .zz-only{color:var(--zz)}`);
  });

  it("do not pick up another OS's parts", function () {
    fs.writeFileSync(part, ".pane .zz-only{color:red}\n");
    expect(css.build({ skins: ["win"] })).not.toContain("zz-only");
  });
});

