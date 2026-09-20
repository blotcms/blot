// Reports, does not enforce: sizes of what ships (raw and brotli), and the contrast of the
// skin's text colours. Fidelity comes first (DESIGN.md §5, §7).
const zlib = require("zlib");
const pane = require("../index");

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
});
