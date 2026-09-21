// Guards against masks going stale when a reference is regenerated with a
// different layout (e.g. a column moved): the masked area must hold text (ink)
// and its left and right edges must be clear, i.e. no text is cut by the mask.

const { loadCases } = require("../lib/cases");
const { loadPng } = require("../lib/image");
const { detectWindowRect, resolveRects, dominantColor } = require("../lib/compare");

describe("pane qa masks", function () {
  loadCases()
    .filter((c) => c.masks.some((m) => m.kind === "time"))
    .forEach((c) => {
      it(`${c.id}: masks cover the time-dependent text`, async function () {
        const img = await loadPng(c.referencePath);
        const rect = detectWindowRect(img);
        const masks = resolveRects(c.masks.filter((m) => m.kind === "time"), rect.w / c.scale, rect.h / c.scale, c.scale, 0);
        for (const m of masks) {
          const x0 = rect.x + m.x;
          const y0 = rect.y + m.y;
          const w = Math.min(m.w, rect.w - m.x);
          const h = Math.min(m.h, rect.h - m.y - 2 * c.scale); // not the window border
          const base = dominantColor(img, { x: x0, y: y0, w, h });
          const isInk = (x, y) => {
            const i = (y * img.width + x) * 4;
            return Math.max(...[0, 1, 2].map((k) => Math.abs(img.data[i + k] - base[k]))) > 60;
          };
          let ink = 0;
          for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (isInk(x, y)) ink++;
          expect(ink).toBeGreaterThan(200, `${m.name} holds no text`);

          const edge = 2 * c.scale;
          for (const start of [x0, x0 + w - edge]) {
            let cut = 0;
            for (let y = y0; y < y0 + h; y++) for (let x = start; x < start + edge; x++) if (isInk(x, y)) cut++;
            expect(cut).toBe(0, `${m.name} cuts through text at x=${start - rect.x}`);
          }
        }
      });
    });
});
