// Serve a comparison of the source site against the translated one, and take
// the maintainer's feedback. Runs ON THE HOST.
//
//   node compare-server.js <verificationDir> [port]
//
// Screenshot pairs rather than live iframes, deliberately: Blot strips
// X-Frame-Options on preview subdomains so the local side *could* be framed, but
// most real sites send frame-ancestors 'self' or X-Frame-Options: DENY and cannot
// be. Pairs always work, and they are the same images the agent is comparing.
//
// Feedback typed here is written to feedback.txt, which the shell loop reads. That
// makes the browser and the terminal two doors into one mechanism rather than two
// mechanisms.

const http = require("http");
const fs = require("fs-extra");
const { join, basename, extname } = require("path");

const DEFAULT_PORT = Number(process.env.TRANSLATE_COMPARE_PORT) || 3021;
const FEEDBACK_FILE = "feedback.txt";
const MANIFEST_FILE = "screenshots.json";

const MIME = {
  ".png": "image/png",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
};

function send(res, status, type, body) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function readManifest(dir) {
  try {
    return await fs.readJson(join(dir, MANIFEST_FILE));
  } catch (e) {
    return { targets: [], captured: [], failed: [] };
  }
}

// Group the flat capture list back into input/output pairs, keeping the order
// the targets were resolved in.
function buildPairs(manifest) {
  const captured = new Set((manifest.captured || []).map((c) => c.label));
  const failures = new Map(
    (manifest.failed || []).map((f) => [f.label, f.error])
  );

  return (manifest.targets || []).map((target) => ({
    label: target.label,
    mobile: !!target.mobile,
    sourceURL: target.source || null,
    localURL: target.local,
    entryPath: target.entryPath || null,
    input: captured.has(`input-${target.label}`)
      ? `input-${target.label}.png`
      : null,
    output: captured.has(`output-${target.label}`)
      ? `output-${target.label}.png`
      : null,
    inputError: failures.get(`input-${target.label}`) || null,
    outputError: failures.get(`output-${target.label}`) || null,
  }));
}

function page(pairs, manifest) {
  const data = JSON.stringify({
    pairs,
    capturedAt: manifest.capturedAt || null,
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>translate — comparison</title>
<style>
  :root {
    --bg: #fff; --fg: #111; --muted: #666; --line: #e5e5e5; --accent: #0a58ca;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #16171a; --fg: #e9e9ea; --muted: #9a9a9e; --line: #2c2d31; --accent: #6ea8fe; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  header {
    padding: 16px 20px; border-bottom: 1px solid var(--line);
    display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
    position: sticky; top: 0; background: var(--bg); z-index: 5;
  }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .muted { color: var(--muted); }
  a { color: var(--accent); }
  main { padding: 20px; max-width: 1400px; margin: 0 auto; }
  section { margin-bottom: 40px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .bar {
    display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
    padding: 10px 14px; border-bottom: 1px solid var(--line);
  }
  .bar h2 { font-size: 14px; margin: 0; font-weight: 600; }
  .spacer { flex: 1; }
  button {
    font: inherit; padding: 4px 10px; border: 1px solid var(--line);
    background: transparent; color: var(--fg); border-radius: 5px; cursor: pointer;
  }
  button[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  input[type=range] { width: 220px; }
  .stage { padding: 14px; }
  .blend { position: relative; line-height: 0; }
  .blend img { width: 100%; display: block; border: 1px solid var(--line); }
  .blend img.top { position: absolute; inset: 0; }
  .sbs { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .sbs figure { margin: 0; }
  .sbs img { width: 100%; display: block; border: 1px solid var(--line); }
  figcaption { font-size: 12px; color: var(--muted); padding-top: 6px; }
  .mobile .blend, .mobile .sbs { max-width: 760px; margin: 0 auto; }
  .note { padding: 14px; color: var(--muted); font-size: 13px; }
  .hidden { display: none !important; }
  textarea {
    width: 100%; min-height: 90px; font: inherit; padding: 10px;
    border: 1px solid var(--line); border-radius: 6px;
    background: transparent; color: var(--fg); resize: vertical;
  }
  .send { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
  .send button { padding: 7px 16px; }
  .ok { color: #1a7f37; }
  @media (prefers-color-scheme: dark) { .ok { color: #57ab5a; } }
</style>
</head>
<body>
<header>
  <h1>translate</h1>
  <span class="muted" id="stamp"></span>
  <span class="spacer"></span>
  <span class="muted">drag the slider to blend source over result</span>
</header>
<main id="main"></main>
<script>
const DATA = ${data};

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  kids.filter(Boolean).forEach((kid) =>
    node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid)
  );
  return node;
}

function pairSection(pair) {
  const hasBoth = pair.input && pair.output;
  const stage = el("div", { class: "stage" });

  if (hasBoth) {
    const top = el("img", { class: "top", src: "/shot/" + pair.input, alt: "source" });
    const blend = el("div", { class: "blend" },
      el("img", { src: "/shot/" + pair.output, alt: "result" }), top);

    const sbs = el("div", { class: "sbs hidden" },
      el("figure", {}, el("img", { src: "/shot/" + pair.input }), el("figcaption", {}, "source")),
      el("figure", {}, el("img", { src: "/shot/" + pair.output }), el("figcaption", {}, "result")));

    const slider = el("input", { type: "range", min: "0", max: "100", value: "50" });
    slider.addEventListener("input", () => { top.style.opacity = slider.value / 100; });
    top.style.opacity = 0.5;

    const blendBtn = el("button", { "aria-pressed": "true" }, "Blend");
    const sbsBtn = el("button", { "aria-pressed": "false" }, "Side by side");

    function mode(isBlend) {
      blendBtn.setAttribute("aria-pressed", String(isBlend));
      sbsBtn.setAttribute("aria-pressed", String(!isBlend));
      blend.classList.toggle("hidden", !isBlend);
      sbs.classList.toggle("hidden", isBlend);
      slider.classList.toggle("hidden", !isBlend);
    }
    blendBtn.addEventListener("click", () => mode(true));
    sbsBtn.addEventListener("click", () => mode(false));

    stage.append(blend, sbs);

    return { stage, controls: [blendBtn, sbsBtn, slider] };
  }

  if (pair.output) {
    stage.append(
      el("div", { class: "note" },
        pair.inputError
          ? "No source screenshot: " + pair.inputError + ". Showing the result only."
          : "No source page to compare against. Showing the result only."),
      el("img", { src: "/shot/" + pair.output, style: "width:100%;display:block" })
    );
    return { stage, controls: [] };
  }

  stage.append(el("div", { class: "note" },
    "Nothing captured for this page" + (pair.outputError ? ": " + pair.outputError : ".")));
  return { stage, controls: [] };
}

function render() {
  const main = document.getElementById("main");
  document.getElementById("stamp").textContent =
    DATA.capturedAt ? "captured " + new Date(DATA.capturedAt).toLocaleString() : "";

  DATA.pairs.forEach((pair) => {
    const { stage, controls } = pairSection(pair);
    const bar = el("div", { class: "bar" },
      el("h2", {}, pair.label),
      ...controls,
      el("span", { class: "spacer" }),
      pair.sourceURL ? el("a", { href: pair.sourceURL, target: "_blank", rel: "noreferrer" }, "open source") : null,
      el("a", { href: pair.localURL, target: "_blank", rel: "noreferrer" }, "open result"));

    main.appendChild(el("section", { class: pair.mobile ? "mobile" : "" }, bar, stage));
  });

  const box = el("textarea", {
    placeholder: "What should change? This goes to the agent as feedback.",
  });
  const status = el("span", { class: "muted" });
  const send = el("button", {}, "Send feedback");

  send.addEventListener("click", async () => {
    const text = box.value.trim();
    if (!text) { status.textContent = "Nothing to send."; return; }
    send.disabled = true;
    status.textContent = "Sending…";
    try {
      const res = await fetch("/feedback", { method: "POST", body: text });
      if (!res.ok) throw new Error("HTTP " + res.status);
      status.className = "ok";
      status.textContent = "Sent — return to the terminal.";
      box.value = "";
    } catch (err) {
      status.className = "muted";
      status.textContent = "Could not send: " + err.message;
    } finally {
      send.disabled = false;
    }
  });

  main.appendChild(el("section", {},
    el("div", { class: "bar" }, el("h2", {}, "Feedback")),
    el("div", { class: "stage" }, box, el("div", { class: "send" }, send, status))));
}

render();
</script>
</body>
</html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // Feedback is prose, not an upload.
      if (size > 64 * 1024) return reject(new Error("Too large"));
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function start(verificationDir, port = DEFAULT_PORT) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    try {
      if (req.method === "GET" && url.pathname === "/") {
        const manifest = await readManifest(verificationDir);
        return send(
          res,
          200,
          MIME[".html"],
          page(buildPairs(manifest), manifest)
        );
      }

      if (req.method === "GET" && url.pathname === "/manifest.json") {
        const manifest = await readManifest(verificationDir);
        return send(res, 200, MIME[".json"], JSON.stringify(manifest, null, 2));
      }

      if (req.method === "GET" && url.pathname.startsWith("/shot/")) {
        // basename() alone defeats traversal: no path separators survive it.
        const name = basename(
          decodeURIComponent(url.pathname.slice("/shot/".length))
        );
        const type = MIME[extname(name).toLowerCase()];

        if (!type) return send(res, 404, "text/plain", "Not found");

        const file = join(verificationDir, name);

        if (!(await fs.pathExists(file)))
          return send(res, 404, "text/plain", "Not found");

        return send(res, 200, type, await fs.readFile(file));
      }

      if (req.method === "POST" && url.pathname === "/feedback") {
        let text;

        try {
          text = (await readBody(req)).trim();
        } catch (err) {
          return send(res, 413, "text/plain", err.message);
        }

        if (!text) return send(res, 400, "text/plain", "Empty");

        await fs.outputFile(join(verificationDir, FEEDBACK_FILE), text + "\n");
        console.log("[compare] Feedback received");
        return send(res, 200, "text/plain", "ok");
      }

      send(res, 404, "text/plain", "Not found");
    } catch (err) {
      send(res, 500, "text/plain", err.message);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use.`));
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      console.log(`url=http://localhost:${port}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  const dir = process.argv[2];
  const port = process.argv[3] ? Number(process.argv[3]) : DEFAULT_PORT;

  if (!dir) {
    console.error("Usage: node compare-server.js <verificationDir> [port]");
    process.exit(1);
  }

  start(dir, port).catch((err) => {
    console.error("[compare]", err.message);
    process.exit(1);
  });
}

module.exports = start;
module.exports.FEEDBACK_FILE = FEEDBACK_FILE;
