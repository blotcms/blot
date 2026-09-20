// Unit tests for the pane QA comparison functions, using synthetic images.
// Pure and fast: no browser, no disk, no Redis.

const {
  createImage,
  cropImage,
  detectWindowRect,
  diffImages,
  diffClusters,
  shadowProfile,
  shadowError,
  textRowBands,
  compareRowBands,
  resolveRects,
  compareImages,
} = require("../lib/compare");
const { evaluate } = require("../lib/thresholds");

function paint(img, rect, color) {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = color[0];
      img.data[i + 1] = color[1];
      img.data[i + 2] = color[2];
      img.data[i + 3] = 255;
    }
  }
}

// A window on the grey desktop with a vertical drop shadow below it
// (`shadow` luminance levels darker at the edge, fading over 8px).
function scene({ w = 160, h = 120, win = { x: 40, y: 30, w: 80, h: 50 }, color = [255, 255, 255], shadow = 0 } = {}) {
  const img = createImage(w, h);
  if (shadow) {
    for (let d = 0; d < 8; d++) {
      const v = 128 - Math.round(shadow * (1 - d / 8));
      paint(img, { x: win.x, y: win.y + win.h + d, w: win.w, h: 1 }, [v, v, v]);
    }
  }
  paint(img, win, color);
  return img;
}

describe("pane qa compare", function () {
  describe("detectWindowRect", function () {
    it("finds a light window on the grey desktop", function () {
      expect(detectWindowRect(scene())).toEqual({ x: 40, y: 30, w: 80, h: 50 });
    });

    it("finds a dark window", function () {
      expect(detectWindowRect(scene({ color: [30, 30, 30] }))).toEqual({ x: 40, y: 30, w: 80, h: 50 });
    });

    it("does not include a soft shadow in the rect", function () {
      expect(detectWindowRect(scene({ shadow: 40 }))).toEqual({ x: 40, y: 30, w: 80, h: 50 });
    });

    it("is not thrown by a stray mark away from the window's edges' centres", function () {
      const img = scene();
      paint(img, { x: 150, y: 110, w: 6, h: 6 }, [255, 255, 255]); // like a watermark
      expect(detectWindowRect(img)).toEqual({ x: 40, y: 30, w: 80, h: 50 });
    });

    it("returns null when there is no window", function () {
      expect(detectWindowRect(createImage(50, 50))).toBeNull();
    });
  });

  describe("cropImage", function () {
    it("crops and fills outside the source with the desktop colour", function () {
      const img = scene();
      const out = cropImage(img, { x: 35, y: 25, w: 10, h: 10 });
      expect(out.width).toBe(10);
      expect(Array.from(out.data.slice(0, 4))).toEqual([128, 128, 128, 255]); // desktop
      const i = (6 * 10 + 6) * 4; // inside the window
      expect(out.data[i]).toBe(255);
      const off = cropImage(img, { x: -5, y: -5, w: 10, h: 10 });
      expect(Array.from(off.data.slice(0, 3))).toEqual([128, 128, 128]);
    });
  });

  describe("diffImages", function () {
    it("reports no difference for identical images", function () {
      const d = diffImages(scene(), scene());
      expect(d.count).toBe(0);
      expect(d.ratio).toBe(0);
      expect(d.compared).toBe(160 * 120);
    });

    it("counts a changed block", function () {
      const b = scene();
      paint(b, { x: 50, y: 40, w: 3, h: 3 }, [255, 0, 0]);
      const d = diffImages(scene(), b);
      expect(d.count).toBe(9);
      expect(d.mask[40 * 160 + 50]).toBe(1);
      expect(d.delta[40 * 160 + 50]).toBe(255);
    });

    it("skips ignored pixels on both sides of the ratio", function () {
      const b = scene();
      paint(b, { x: 50, y: 40, w: 3, h: 3 }, [255, 0, 0]);
      const ignore = new Uint8Array(160 * 120);
      for (let y = 38; y < 44; y++) for (let x = 48; x < 56; x++) ignore[y * 160 + x] = 1;
      const d = diffImages(scene(), b, { ignore });
      expect(d.count).toBe(0);
      expect(d.compared).toBe(160 * 120 - 6 * 8);
    });

    it("tolerates differences below the threshold", function () {
      const b = scene({ color: [252, 252, 252] });
      expect(diffImages(scene(), b, { threshold: 0.1 }).count).toBe(0);
      expect(diffImages(scene(), scene({ color: [200, 200, 200] }), { threshold: 0.1 }).count).toBe(80 * 50);
    });

    it("rejects images of different sizes", function () {
      expect(() => diffImages(createImage(4, 4), createImage(5, 4))).toThrow();
    });
  });

  describe("diffClusters", function () {
    function maskWith(w, h, blobs) {
      const mask = new Uint8Array(w * h);
      const delta = new Uint8Array(w * h);
      for (const b of blobs) {
        for (let y = b.y; y < b.y + b.h; y++) {
          for (let x = b.x; x < b.x + b.w; x++) {
            mask[y * w + x] = 1;
            delta[y * w + x] = b.delta;
          }
        }
      }
      return { mask, delta };
    }

    it("returns bounding boxes ranked by area, with area and mean delta", function () {
      const { mask, delta } = maskWith(100, 100, [
        { x: 5, y: 5, w: 4, h: 4, delta: 100 },
        { x: 60, y: 60, w: 20, h: 10, delta: 50 },
      ]);
      const clusters = diffClusters(mask, delta, 100, 100);
      expect(clusters.length).toBe(2);
      expect(clusters[0]).toEqual({ x: 60, y: 60, w: 20, h: 10, area: 200, meanDelta: 50 });
      expect(clusters[1]).toEqual({ x: 5, y: 5, w: 4, h: 4, area: 16, meanDelta: 100 });
    });

    it("joins pixels that are close together and keeps distant ones apart", function () {
      const { mask, delta } = maskWith(100, 40, [
        { x: 10, y: 10, w: 3, h: 3, delta: 10 },
        { x: 17, y: 10, w: 3, h: 3, delta: 10 }, // 4px gap: same blob
        { x: 80, y: 10, w: 3, h: 3, delta: 10 },
      ]);
      const clusters = diffClusters(mask, delta, 100, 40);
      expect(clusters.length).toBe(2);
      expect(clusters[0].w).toBe(10);
    });

    it("returns nothing when nothing differs", function () {
      expect(diffClusters(new Uint8Array(100), new Uint8Array(100), 10, 10)).toEqual([]);
    });
  });

  describe("shadowProfile / shadowError", function () {
    const rect = { x: 40, y: 30, w: 80, h: 50 };

    it("samples luminance outwards from each edge", function () {
      const p = shadowProfile(scene({ shadow: 40 }), rect, { distance: 10 });
      expect(p.bottom.length).toBe(10);
      expect(p.bottom[0]).toBeCloseTo(128 - 40 * (1 - 0 / 8), 0);
      expect(p.bottom[7]).toBeGreaterThan(p.bottom[0]);
      expect(p.bottom[9]).toBeCloseTo(128, 5);
      expect(p.top.every((v) => Math.abs(v - 128) < 0.01)).toBe(true);
    });

    it("has no error against itself and knows a flat desktop has no shadow", function () {
      const shadowed = shadowProfile(scene({ shadow: 40 }), rect, { distance: 10 });
      const same = shadowError(shadowed, shadowed);
      expect(same.error).toBe(0);
      expect(same.referenceHasShadow).toBe(true);

      const flat = shadowProfile(scene(), rect, { distance: 10 });
      expect(shadowError(flat, flat).referenceHasShadow).toBe(false);
    });

    it("measures how far a rendered shadow is from the reference", function () {
      const ref = shadowProfile(scene({ shadow: 40 }), rect, { distance: 10 });
      const light = shadowProfile(scene({ shadow: 20 }), rect, { distance: 10 });
      const flat = shadowProfile(scene(), rect, { distance: 10 });
      const near = shadowError(ref, light);
      const far = shadowError(ref, flat);
      expect(near.error).toBeGreaterThan(0);
      expect(far.error).toBeGreaterThan(near.error);
      expect(far.curves.reference).toBe(ref);
      expect(far.edges.bottom.rmse).toBeGreaterThan(far.edges.top.rmse);
      // shadowless reference vs. a rendering that adds one is penalised too
      const added = shadowError(flat, ref);
      expect(added.referenceHasShadow).toBe(false);
      expect(added.renderedHasShadow).toBe(true);
      expect(added.error).toBeGreaterThan(0);
    });
  });

  describe("text rows", function () {
    function rows(ys) {
      const img = createImage(100, 80, [255, 255, 255, 255]);
      for (const y of ys) paint(img, { x: 20, y, w: 40, h: 6 }, [0, 0, 0]);
      return img;
    }
    const whole = { x: 0, y: 0, w: 100, h: 80 };

    it("finds a band per line of ink", function () {
      const bands = textRowBands(rows([10, 30, 50]), whole, null, { edgeInset: 0 });
      expect(bands.map((b) => [b.y0, b.y1])).toEqual([[10, 15], [30, 35], [50, 55]]);
      expect(bands[0].x0).toBe(20);
      expect(bands[0].x1).toBe(59);
    });

    it("ignores masked pixels", function () {
      const ignore = new Uint8Array(100 * 80);
      for (let y = 25; y < 40; y++) for (let x = 0; x < 100; x++) ignore[y * 100 + x] = 1;
      expect(textRowBands(rows([10, 30, 50]), whole, ignore, { edgeInset: 0 }).length).toBe(2);
    });

    it("compares where rows sit, not what is in them", function () {
      const a = textRowBands(rows([10, 30, 50]), whole, null, { edgeInset: 0 });
      const b = textRowBands(rows([12, 30, 54]), whole, null, { edgeInset: 0 });
      const c = compareRowBands(a, b);
      expect(c.matched).toBe(3);
      expect(c.maxYOffset).toBe(4);
      expect(c.meanYOffset).toBeCloseTo(2, 5);
      expect(compareRowBands(a, a.slice(0, 2)).renderedRows).toBe(2);
    });
  });

  describe("resolveRects", function () {
    it("converts window-relative CSS px to crop pixels", function () {
      const [a, b, c] = resolveRects(
        [
          { name: "a", x: 10, y: 5, w: 20, h: 10 },
          { name: "b", right: 30, y: 0, w: 10, h: null },
          { name: "c", bottom: 0, x: 0, w: null, h: 8 },
        ],
        100,
        50,
        2,
        16
      );
      expect(a).toEqual({ name: "a", kind: undefined, x: 36, y: 26, w: 40, h: 20 });
      expect(b.x).toBe(16 + 2 * (100 - 30 - 10));
      expect(b.h).toBe(100);
      expect(c.y).toBe(16 + 2 * (50 - 8));
      expect(c.w).toBe(200);
    });
  });

  describe("compareImages", function () {
    const def = {
      scale: 1,
      masks: [{ name: "date", kind: "time", x: 50, y: 5, w: 20, h: 10 }],
      regions: [
        { name: "titlebar", kind: "chrome", x: 0, y: 0, w: null, h: 20 },
        { name: "content", kind: "text", x: 0, y: 20, w: null, h: null },
      ],
    };

    it("aligns windows at different positions and finds no difference", function () {
      const ref = scene({ shadow: 30 });
      const rendered = scene({ w: 200, h: 140, win: { x: 70, y: 50, w: 80, h: 50 }, shadow: 30 });
      const r = compareImages(ref, rendered, def, { margin: 10 });
      expect(r.diff.count).toBe(0);
      expect(r.geometry.referenceRect).toEqual({ x: 40, y: 30, w: 80, h: 50 });
      expect(r.geometry.renderedRect).toEqual({ x: 70, y: 50, w: 80, h: 50 });
      expect(r.shadow.error).toBeLessThan(0.5);
      expect(r.clusters).toEqual([]);
      expect(r.images.diff.width).toBe(80 + 20);
    });

    it("reports differences per region, in window-relative pixels, but not masked ones", function () {
      const ref = scene();
      const rendered = scene();
      paint(rendered, { x: 40 + 10, y: 30 + 30, w: 10, h: 5 }, [0, 0, 0]); // content
      paint(rendered, { x: 40 + 52, y: 30 + 6, w: 5, h: 5 }, [0, 0, 0]); // in the mask
      const r = compareImages(ref, rendered, def, { margin: 10 });
      expect(r.diff.count).toBe(50);
      const byName = Object.fromEntries(r.regions.map((g) => [g.name, g]));
      expect(byName.content.count).toBe(50);
      expect(byName.titlebar.count).toBe(0);
      expect(r.clusters.length).toBe(1);
      // window-relative cluster: crop coords minus the 10px margin
      expect(r.clusters[0].x - 10).toBe(10);
      expect(r.clusters[0].y - 10).toBe(30);
    });

    it("reports an error when a window cannot be found", function () {
      expect(compareImages(scene(), createImage(50, 50), def).error).toMatch(/rendered/);
    });
  });

  describe("evaluate", function () {
    const entry = {
      id: "x",
      scale: 2,
      diff: { percent: 3 },
      geometry: { sizeDelta: { w: 1, h: -2 } },
      rows: { meanYOffset: 2 },
      shadow: { error: 4 },
      regions: [
        { name: "titlebar", kind: "chrome", percent: 6 },
        { name: "content", kind: "text", percent: 6 },
      ],
    };
    const limits = { default: { diffPercent: { overall: 8, chrome: 5, text: 15 }, shadowError: 10, sizeDelta: 4, rowYOffset: 4 } };

    it("holds chrome to a stricter limit than text", function () {
      const v = evaluate(entry, limits);
      expect(v.pass).toBe(false);
      expect(v.failures.map((f) => f.region)).toEqual(["titlebar"]);
    });

    it("lets a case override individual limits", function () {
      const v = evaluate(entry, { ...limits, cases: { x: { diffPercent: { titlebar: 7 }, shadowError: 3 } } });
      expect(v.failures.map((f) => f.metric)).toEqual(["shadowError"]);
    });
  });
});
