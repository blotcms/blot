// Local viewer for the pane QA comparison: node app/helper/pane/qa [--port N]
// Binds to 127.0.0.1 only. Static UI lives in qa/public.

const express = require("express");
const fs = require("fs");
const path = require("path");
const cases = require("./lib/cases");
const adapter = require("./adapter");
const { loadThresholds } = require("./lib/thresholds");
const { analyze, outDir, IMAGES } = require("./lib/run");
const { launch, renderCase } = require("./lib/render");

function createServer() {
  const app = express();
  const cache = new Map(); // id -> Promise<entry>
  const clients = new Set();
  let version = 1; // bumped on any change; the UI appends it to image URLs
  let browser = null;

  const find = (req, res) => {
    const c = cases.getCase(req.params.id);
    if (!c) res.status(404).json({ error: "unknown case" });
    return c;
  };

  const entryFor = (c) => {
    if (!cache.has(c.id)) cache.set(c.id, analyze(c, loadThresholds()));
    return cache.get(c.id);
  };

  const summary = async (c) => {
    const e = await entryFor(c);
    return {
      ...cases.describe(c),
      status: e.status,
      message: e.message,
      diffPercent: e.diff ? e.diff.percent : null,
      shadowError: e.shadow ? e.shadow.error : null,
      hasFixture: true, // the pane module, or a fixture as fallback
    };
  };

  function changed(what) {
    cache.clear();
    version++;
    for (const res of clients) res.write(`data: ${JSON.stringify({ version, what })}\n\n`);
  }

  app.get("/favicon.ico", (req, res) => res.status(204).end());
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/cases", async (req, res, next) => {
    try {
      const list = [];
      for (const c of cases.loadCases()) list.push(await summary(c));
      res.json({ version, cases: list });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/cases/:id", async (req, res, next) => {
    const c = find(req, res);
    if (!c) return;
    try {
      res.json({ version, case: { ...(await summary(c)) }, report: await entryFor(c) });
    } catch (err) {
      next(err);
    }
  });

  app.get("/img/:id/:name.png", async (req, res, next) => {
    const c = find(req, res);
    if (!c) return;
    if (!IMAGES.includes(req.params.name)) return res.status(404).end();
    try {
      await entryFor(c);
      const file = path.join(outDir(c.id), `${req.params.name}.png`);
      if (!fs.existsSync(file)) return res.status(404).end();
      res.set("Cache-Control", "no-store").sendFile(file);
    } catch (err) {
      next(err);
    }
  });

  // The case's HTML as the renderer would see it, for the live iframe view.
  app.get("/fixture/:id", async (req, res, next) => {
    const c = find(req, res);
    if (!c) return;
    try {
      const result = await adapter.render(c.id);
      if (!result) return res.status(404).type("text").send("No fixture or adapter output for this case.");
      res.set("Cache-Control", "no-store").type("html").send(adapter.composePage(c, result));
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/cases/:id/render", async (req, res, next) => {
    if (req.get("X-Requested-With") !== "pane-qa") return res.status(400).json({ error: "bad request" });
    const c = find(req, res);
    if (!c) return;
    try {
      browser = browser || (await launch());
      const result = await renderCase(browser, c);
      if (!result) return res.status(404).json({ error: "no fixture or adapter output for this case" });
      changed(c.id);
      res.json({ ok: true, version });
    } catch (err) {
      next(err);
    }
  });

  app.get("/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ version })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  // Live reload: rendered images, fixtures, thresholds, masks, references.
  let timer = null;
  const targets = [cases.FIXTURES_DIR, __dirname, ...cases.OS_LIST.map((os) => path.join(cases.RENDERED_DIR, os)),
    ...cases.OS_LIST.map((os) => path.join(cases.REFERENCE_DIR, os))];
  const watchers = [];
  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue;
    try {
      watchers.push(
        fs.watch(dir, (event, file) => {
          if (dir === __dirname && !/^(thresholds|masks)\.json$/.test(file || "")) return;
          clearTimeout(timer);
          timer = setTimeout(() => changed(file || dir), 200);
        })
      );
    } catch (err) {
      // watching is a convenience; ignore platforms/dirs that can't
    }
  }

  app.close = async () => {
    watchers.forEach((w) => w.close());
    for (const res of clients) res.end();
    if (browser) await browser.close();
  };
  return app;
}

module.exports = { createServer };
