// KaTeX test fixture preview server
//
// Renders each file in tests/examples/ side by side: source, expected HTML, and
// actual build output. Use it to visually confirm that equations render correctly
// after changing the plugin or adding new test fixtures.
//
//   node app/build/plugins/katex/preview.js
//   open http://localhost:7843

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.KATEX_PREVIEW_PORT) || 7843;
const EXAMPLES_DIR = path.join(__dirname, "tests/examples");
const SUPPORTED_EXTENSIONS = [".txt", ".md", ".gdoc", ".rtf"];
const KATEX_DIST = path.join(
  path.dirname(require.resolve("katex/package.json")),
  "dist"
);

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slug(name) {
  return name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function loadExamples() {
  return fs
    .readdirSync(EXAMPLES_DIR)
    .filter((file) => SUPPORTED_EXTENSIONS.some((ext) => file.endsWith(ext)))
    .sort()
    .map((file) => {
      const inputPath = path.join(EXAMPLES_DIR, file);
      const expectedPath = inputPath + ".html";
      const actualPath = expectedPath + ".expected.html";

      return {
        file,
        id: slug(file),
        input: fs.readFileSync(inputPath, "utf8"),
        expected: fs.existsSync(expectedPath)
          ? fs.readFileSync(expectedPath, "utf8")
          : null,
        actual: fs.existsSync(actualPath)
          ? fs.readFileSync(actualPath, "utf8")
          : null,
      };
    });
}

function renderPage(examples) {
  const nav = examples
    .map(
      (ex) =>
        `<li><a href="#${escapeHtml(ex.id)}">${escapeHtml(ex.file)}</a></li>`
    )
    .join("\n");

  const cards = examples
    .map((ex) => {
      const columns = [
        `<div class="column">
          <h3>Input</h3>
          <pre>${escapeHtml(ex.input)}</pre>
        </div>`,
        `<div class="column">
          <h3>Rendered output</h3>
          <div class="output">${ex.expected || "<em>No .html fixture</em>"}</div>
        </div>`,
      ];

      if (ex.actual !== null) {
        columns.push(`<div class="column actual">
          <h3>Actual (last failed run)</h3>
          <div class="output">${ex.actual}</div>
        </div>`);
      }

      const details = [
        ex.expected &&
          `<details><summary>Raw expected HTML</summary><pre>${escapeHtml(ex.expected)}</pre></details>`,
        ex.actual &&
          `<details><summary>Raw actual HTML</summary><pre>${escapeHtml(ex.actual)}</pre></details>`,
      ]
        .filter(Boolean)
        .join("\n");

      const markCorrect =
        ex.actual !== null
          ? `<form method="POST" action="/mark-correct" style="display:inline">
              <input type="hidden" name="file" value="${escapeHtml(ex.file)}">
              <button type="submit">Mark as correct</button>
            </form>`
          : "";

      return `<section class="example" id="${escapeHtml(ex.id)}">
        <h2>${escapeHtml(ex.file)} ${markCorrect}</h2>
        <div class="columns${ex.actual ? " has-actual" : ""}">${columns.join("")}</div>
        ${details}
      </section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KaTeX test preview</title>
  <link rel="stylesheet" href="/katex/katex.min.css">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #111;
      background: #f5f5f5;
    }
    .layout {
      display: flex;
      min-height: 100vh;
    }
    nav {
      position: sticky;
      top: 0;
      align-self: flex-start;
      width: 220px;
      max-height: 100vh;
      overflow: auto;
      padding: 1.25rem 1rem;
      background: #fff;
      border-right: 1px solid #ddd;
    }
    nav h1 {
      margin: 0 0 0.75rem;
      font-size: 1rem;
    }
    nav ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    nav li + li { margin-top: 0.35rem; }
    nav a {
      color: #0366d6;
      text-decoration: none;
      word-break: break-all;
    }
    nav a:hover { text-decoration: underline; }
    main {
      flex: 1;
      padding: 1.5rem 2rem 3rem;
      max-width: 1200px;
    }
    .example {
      margin-bottom: 2.5rem;
      padding: 1.25rem;
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 6px;
    }
    .example h2 {
      margin: 0 0 1rem;
      font-size: 1.1rem;
      font-weight: 600;
    }
    .example h2 button {
      margin-left: 0.5rem;
      font: inherit;
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
    }
    .columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    .columns.has-actual {
      grid-template-columns: 1fr 1fr 1fr;
    }
    .column h3 {
      margin: 0 0 0.5rem;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #666;
    }
    .column.actual h3 { color: #b45309; }
    pre {
      margin: 0;
      padding: 0.75rem;
      overflow: auto;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #f8f8f8;
      border: 1px solid #eee;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .output {
      padding: 0.75rem;
      min-height: 3rem;
      background: #fff;
      border: 1px solid #eee;
      border-radius: 4px;
    }
    .output p:first-child { margin-top: 0; }
    .output p:last-child { margin-bottom: 0; }
    details {
      margin-top: 0.75rem;
    }
    summary {
      cursor: pointer;
      color: #666;
      font-size: 0.85rem;
    }
    @media (max-width: 900px) {
      .layout { flex-direction: column; }
      nav {
        position: static;
        width: 100%;
        max-height: none;
        border-right: none;
        border-bottom: 1px solid #ddd;
      }
      .columns, .columns.has-actual {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <nav>
      <h1>KaTeX tests</h1>
      <ul>${nav}</ul>
    </nav>
    <main>${cards}</main>
  </div>
</body>
</html>`;
}

async function serveKatexAsset(urlPath, res) {
  const relative = urlPath.replace(/^\/katex\/?/, "") || "katex.min.css";
  const filePath = path.normalize(path.join(KATEX_DIST, relative));

  if (!filePath.startsWith(KATEX_DIST)) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }

  let data;

  try {
    data = await fs.promises.readFile(filePath);
  } catch (err) {
    res.statusCode = err.code === "ENOENT" ? 404 : 500;
    return res.end(err.code === "ENOENT" ? "Not found" : "Error");
  }

  const ext = path.extname(filePath);
  const types = {
    ".css": "text/css; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
  };

  res.setHeader("Content-Type", types[ext] || "application/octet-stream");
  res.end(data);
}

function markCorrect(file) {
  if (
    !file ||
    path.basename(file) !== file ||
    !SUPPORTED_EXTENSIONS.some((ext) => file.endsWith(ext))
  ) {
    throw new Error("Invalid file");
  }

  const expectedPath = path.join(EXAMPLES_DIR, file + ".html");
  const actualPath = expectedPath + ".expected.html";

  if (!fs.existsSync(actualPath)) {
    throw new Error("No .expected.html for " + file);
  }

  if (fs.existsSync(expectedPath)) fs.unlinkSync(expectedPath);
  fs.renameSync(actualPath, expectedPath);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "POST" && url.pathname === "/mark-correct") {
      try {
        const body = await readBody(req);
        const file = new URLSearchParams(body).get("file");
        markCorrect(file);
        res.statusCode = 302;
        res.setHeader("Location", "/#" + slug(file));
        return res.end();
      } catch (err) {
        res.statusCode = 400;
        return res.end(String(err.message || err));
      }
    }

    if (req.method !== "GET") {
      res.statusCode = 405;
      return res.end("Method not allowed");
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = renderPage(loadExamples());
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(html);
    }

    if (url.pathname === "/katex" || url.pathname.startsWith("/katex/")) {
      return serveKatexAsset(url.pathname, res);
    }

    res.statusCode = 404;
    res.end("Not found");
  })
  .listen(PORT, () => {
    const examples = loadExamples();
    console.log(`KaTeX preview: http://localhost:${PORT}`);
    console.log(`${examples.length} examples from ${EXAMPLES_DIR}`);
  });
