// A local gallery of pane's windows, rendered live from the current code.
// node app/helper/pane/gallery [--port N]   (binds to 127.0.0.1 only)

const express = require("express");
const fs = require("fs");
const path = require("path");

const PANE_DIR = path.join(__dirname, "..");
const GALLERY_DIR = __dirname;
const REFERENCE_DIR = path.join(PANE_DIR, "reference");

// Forget every pane module except the gallery's own, so the next require reads the files again.
function loadPane() {
  for (const file of Object.keys(require.cache)) {
    if (
      file.startsWith(PANE_DIR + path.sep) &&
      !file.startsWith(GALLERY_DIR + path.sep)
    )
      delete require.cache[file];
  }
  // the page builder and fixtures are re-read too (this server and the CLI are not)
  for (const name of ["./fixtures", "./page"])
    delete require.cache[require.resolve(name)];
  return {
    pane: require("../index"),
    fixtures: require("./fixtures"),
    page: require("./page").page,
  };
}

function createServer() {
  const app = express();
  const clients = new Set();

  app.get("/favicon.ico", (req, res) => res.status(204).end());
  app.use("/_gallery", express.static(path.join(GALLERY_DIR, "public")));
  app.use("/fixtures", express.static(path.join(GALLERY_DIR, "fixtures")));
  app.use("/reference", express.static(REFERENCE_DIR, { index: false }));

  app.get("/", (req, res, next) => {
    try {
      const { pane, fixtures, page } = loadPane();
      res
        .set("Cache-Control", "no-store")
        .type("html")
        .send(
          page({ pane, fixtures, os: req.query.os, theme: req.query.theme })
        );
    } catch (err) {
      next(err);
    }
  });

  app.get("/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).type("text").send(`pane gallery error: ${err.stack}`);
  });

  // Reload open pages when pane's code, a fixture or a reference changes.
  let timer = null;
  let watcher = null;
  try {
    watcher = fs.watch(PANE_DIR, { recursive: true }, (event, file) => {
      if (!file || /^(rendered|screenshots|qa)[\\/]/.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const res of clients) res.write("data: reload\n\n");
      }, 150);
    });
  } catch (err) {
    // watching is a convenience; reloading by hand still works
  }

  app.close = () => {
    clearTimeout(timer);
    if (watcher) watcher.close();
    for (const res of clients) res.end();
  };
  return app;
}

module.exports = { createServer, loadPane };
