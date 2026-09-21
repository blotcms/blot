// Reports, does not enforce: sizes of what ships (raw and brotli), and the contrast of the
// skin's text colours. Fidelity comes first (DESIGN.md §5, §7).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const pane = require("../index");
const { items, SKINS } = require("../lib/css");

const brotli = (s) => zlib.brotliCompressSync(Buffer.from(s)).length;

describe("pane size report", function () {
  it("prints CSS, JS and HTML sizes", function () {
    const { css, js } = pane.assets();
    const one = pane.folder("Fruits\n  Apple.md\nAbout.txt").html;
    const rows = Array.from({ length: 15 }, (_, i) => `File ${i}.md`).join("\n");
    const window15 = pane.folder(rows).html;
    const line = (name, s) => `${name.padEnd(22)} ${String(Buffer.byteLength(s)).padStart(7)} B raw ${String(brotli(s)).padStart(6)} B brotli`;
    console.log(["pane sizes", line("css", css), line("js", js), line("html, 3 rows", one), line("html, 15 rows", window15)].join("\n  "));
    expect(css.length).toBeGreaterThan(0);
  });

  // Text colours against the row background, per skin and scheme (WCAG 2 ratio).
  it("prints the contrast of the skin's text colours", function () {
    const luminance = (hex) => {
      const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const lines = [];
    for (const os of SKINS) {
      const blocks = items(fs.readFileSync(path.join(__dirname, "..", "css", `${os}.css`), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""));
      for (const scheme of ["light", "dark"]) {
        const body = blocks.find((b) => b.sel === `@${scheme}`).body;
        const tokens = Object.fromEntries([...body.matchAll(/--([\w-]+):(#[0-9a-f]{3,6})\b/gi)].map((m) => [m[1], m[2]]));
        for (const [name, bg] of [["fg", "bg"], ["dim", "bg"], ["dim", "stripe"], ["title", "bg"]]) {
          if (tokens[name] && tokens[bg]) lines.push(`${os} ${scheme} ${name} on ${bg}`.padEnd(28) + ratio(tokens[name], tokens[bg]).toFixed(2));
        }
      }
    }
    console.log(["pane contrast (WCAG ratio; fidelity wins, 4.5 is not enforced)", ...lines].join("\n  "));
    expect(lines.length).toBeGreaterThan(0);
  });
});
