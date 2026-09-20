// pane QA viewer. Plain browser JS, no build step.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MAX_ZOOM = 4;
  const MIN_ZOOM = 0.1;

  const state = {
    cases: [],
    id: null,
    detail: null, // { case, report }
    version: 0,
    mode: "side",
    diffMode: "diff",
    view: { z: 1, x: 0, y: 0 },
    swipe: 50,
    onion: 50,
    blinkTimer: null,
    blinkShowRendered: false,
    selectedCluster: -1,
    panes: [],
    renderToken: 0,
    pixels: {}, // url -> { width, height, data }
  };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c);
    return el;
  }

  const hex = (px) => "#" + [0, 1, 2].map((i) => px[i].toString(16).padStart(2, "0")).join("");
  const num = (v, p = 2) => (typeof v === "number" ? v.toFixed(p) : "-");
  const imgUrl = (name) => `/img/${encodeURIComponent(state.id)}/${name}.png?v=${state.version}`;
  const say = (text) => ($("status").textContent = text);

  // ---------------------------------------------------------------- data
  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }

  async function loadList() {
    const data = await getJSON("/api/cases");
    state.version = data.version;
    state.cases = data.cases;
    fillFilters();
    renderList();
  }

  async function loadDetail() {
    if (!state.id) return;
    const id = state.id;
    const detail = await getJSON(`/api/cases/${encodeURIComponent(id)}`);
    if (id !== state.id) return;
    state.version = detail.version;
    state.detail = detail;
    await renderDetail(true);
  }

  // Decodes an image into pixel data once, for the pixel readout.
  function loadPixels(url) {
    if (state.pixels[url]) return Promise.resolve(state.pixels[url]);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        state.pixels[url] = { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
        resolve(state.pixels[url]);
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // ---------------------------------------------------------------- list
  function fillFilters() {
    for (const [id, key] of [["f-os", "os"], ["f-theme", "theme"], ["f-view", "view"]]) {
      const select = $(id);
      const chosen = select.value;
      const values = [...new Set(state.cases.map((c) => c[key]))];
      select.replaceChildren(h("option", { value: "", text: "all" }), ...values.map((v) => h("option", { value: v, text: v })));
      select.value = values.includes(chosen) ? chosen : "";
    }
  }

  function visibleCases() {
    const f = { os: $("f-os").value, theme: $("f-theme").value, view: $("f-view").value, status: $("f-status").value };
    return state.cases.filter((c) => Object.entries(f).every(([k, v]) => !v || c[k] === v));
  }

  function renderList() {
    const list = visibleCases();
    const counts = {};
    for (const c of state.cases) counts[c.status] = (counts[c.status] || 0) + 1;
    $("summary").textContent = `${state.cases.length} cases: ` + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
    $("case-list").replaceChildren(
      ...list.map((c) =>
        h("li", {},
          h("button", { type: "button", "data-id": c.id, "aria-current": c.id === state.id ? "true" : false, onclick: () => select(c.id) },
            h("span", { text: c.id }),
            h("span", { class: `badge ${c.status}`, text: c.status + (c.diffPercent !== null ? ` ${c.diffPercent.toFixed(1)}%` : "") })
          )
        )
      )
    );
  }

  function select(id, opts = {}) {
    if (!state.cases.some((c) => c.id === id)) return;
    state.id = id;
    state.selectedCluster = -1;
    history.replaceState(null, "", "#" + id);
    renderList();
    if (opts.focusList) $("case-list").querySelector('[aria-current="true"]')?.focus();
    loadDetail().catch((err) => say(err.message));
  }

  function step(delta) {
    const list = visibleCases();
    if (!list.length) return;
    const i = list.findIndex((c) => c.id === state.id);
    const next = list[(i + delta + list.length) % list.length];
    select(next.id);
    $("case-list").querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // ---------------------------------------------------------------- detail
  async function renderDetail(keepView) {
    const { case: c, report } = state.detail;
    $("case-title").textContent = c.id;
    $("case-meta").textContent =
      `${c.os} / ${c.theme} / ${c.view} view / @${c.scale}x · reference ${c.reference} · rendered ${c.rendered}` +
      (c.hasFixture ? "" : " · no fixture or adapter output for this case");
    renderMetrics(report);
    renderClusters(report);
    renderShadow(report);
    await renderStage(keepView);
  }

  function renderMetrics(r) {
    const box = $("metrics");
    if (!r.diff) {
      box.replaceChildren(h("p", { text: r.message || r.status }));
      return;
    }
    const failed = (region) => r.failures.some((f) => f.region === region);
    const row = (label, value, bad) => h("tr", {}, h("th", { scope: "row", text: label }), h("td", { class: "num" + (bad ? " failtext" : ""), text: value }));
    const table = h("table", {},
      h("tbody", {},
        row("Result", r.status.toUpperCase(), r.status !== "pass"),
        row("Window (css px)", `${num(r.geometry.windowLogical.w, 1)} x ${num(r.geometry.windowLogical.h, 1)}`),
        row("Rendered size delta", `${num(r.geometry.sizeDelta.w, 1)} x ${num(r.geometry.sizeDelta.h, 1)}`, r.failures.some((f) => f.metric === "sizeDelta")),
        row("Diff (unmasked pixels)", `${num(r.diff.percent)}%  (${r.diff.count}/${r.diff.compared})`, failed("overall")),
        ...r.regions.map((g) => row(`  ${g.name} (${g.kind})`, `${num(g.percent)}%`, failed(g.name))),
        row("Text rows ref / rendered", `${r.rows.referenceRows} / ${r.rows.renderedRows}`),
        row("Text row offset y / x", `${num(r.rows.meanYOffset / r.scale, 1)} / ${num(r.rows.meanXOffset / r.scale, 1)} px`, r.failures.some((f) => f.metric === "rowYOffset")),
        row("Shadow error (RMSE)", num(r.shadow.error, 1), r.failures.some((f) => f.metric === "shadowError")),
        row("Masked regions", r.masks.map((m) => m.name).join(", ") || "none")
      )
    );
    box.replaceChildren(table);
  }

  function renderClusters(r) {
    const ol = $("clusters");
    if (!r.clusters) return ol.replaceChildren(h("li", { text: "No comparison available." }));
    ol.replaceChildren(
      ...r.clusters.slice(0, 40).map((c, i) =>
        h("li", {},
          h("button", { type: "button", "aria-current": i === state.selectedCluster ? "true" : false, onclick: () => selectCluster(i) },
            `${Math.round(c.x)},${Math.round(c.y)}  ${Math.round(c.w)}x${Math.round(c.h)}  ${c.region || "?"}  area ${Math.round(c.areaCss)}px², Δ${Math.round(c.meanDelta)}`
          )
        )
      )
    );
  }

  // Inline SVG line charts of luminance vs distance from each window edge.
  function renderShadow(r) {
    const box = $("shadow");
    if (!r.shadow) return box.replaceChildren(h("p", { text: "No comparison available." }));
    const s = r.shadow;
    const W = 220, H = 110, L = 28, B = 16, T = 6, R = 6;
    const charts = ["top", "bottom", "left", "right"].map((edge) => {
      const ref = s.curves.reference[edge], rend = s.curves.rendered[edge];
      const values = [...ref, ...rend, s.bgLuma];
      const lo = Math.floor(Math.min(...values) - 3), hi = Math.ceil(Math.max(...values) + 3);
      const n = Math.max(ref.length, rend.length, 2);
      const X = (i) => L + (i / (n - 1)) * (W - L - R);
      const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
      const path = (arr) => arr.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label",
        `${edge} edge shadow: luminance against distance from the window edge. Reference ${ref.length ? num(Math.min(...ref), 0) : "n/a"} to ${ref.length ? num(Math.max(...ref), 0) : "n/a"}, rendered ${rend.length ? num(Math.min(...rend), 0) : "n/a"} to ${rend.length ? num(Math.max(...rend), 0) : "n/a"}, error ${num(s.edges[edge].rmse, 1)}.`);
      svg.innerHTML =
        `<line class="axis" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"/><line class="axis" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>` +
        `<line class="base" x1="${L}" y1="${Y(s.bgLuma)}" x2="${W - R}" y2="${Y(s.bgLuma)}"/>` +
        `<path class="ref" d="${path(ref)}"/><path class="rend" d="${path(rend)}"/>` +
        `<text x="2" y="${T + 8}">${hi}</text><text x="2" y="${H - B}">${lo}</text>` +
        `<text x="${L}" y="${H - 4}">0</text><text x="${W - R - 40}" y="${H - 4}">${Math.round((n - 1) / r.scale)}px</text>`;
      return h("figure", {}, svg, h("figcaption", { text: `${edge}: error ${num(s.edges[edge].rmse, 1)}` }));
    });
    box.replaceChildren(
      h("p", { class: "legend" },
        h("span", { text: "── reference" }), h("span", { text: "- - rendered" }), h("span", { text: `dotted = desktop (${num(s.bgLuma, 0)})` })),
      h("p", { class: "muted", text: `Mean error ${num(s.error, 1)}. ` + (s.referenceHasShadow ? "" : "The reference has no shadow (flat line): the rendering should not add one. ") + "Luminance vs px from the window edge." }),
      h("div", { class: "charts" }, ...charts)
    );
  }

  // ---------------------------------------------------------------- stage
  function overlay(report) {
    const g = report.geometry.cropPx;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", g.w);
    svg.setAttribute("height", g.h);
    svg.setAttribute("viewBox", `0 0 ${g.w} ${g.h}`);
    svg.setAttribute("aria-hidden", "true");
    const px = (v) => v * report.scale + g.margin;
    let markup = "";
    if ($("show-masks").checked) {
      for (const m of report.masks) markup += `<rect class="ov-mask" x="${px(m.x)}" y="${px(m.y)}" width="${m.w * report.scale}" height="${m.h * report.scale}"/>`;
    }
    if ($("show-clusters").checked) {
      report.clusters.slice(0, 40).forEach((c, i) => {
        markup += `<rect class="ov-cluster${i === state.selectedCluster ? " sel" : ""}" x="${px(c.x)}" y="${px(c.y)}" width="${c.w * report.scale}" height="${c.h * report.scale}"/>` +
          (i < 15 ? `<text class="ov-label" x="${px(c.x)}" y="${px(c.y) - 3}">${i + 1}</text>` : "");
      });
    }
    svg.innerHTML = markup;
    return svg;
  }

  function makePane(title, layers, report) {
    const g = report.geometry.cropPx;
    const stage = h("div", { class: "stage" });
    const imgs = {};
    for (const layer of layers) {
      const img = h("img", { src: imgUrl(layer), width: g.w, height: g.h, alt: `${layer} image`, draggable: "false" });
      imgs[layer] = img;
      stage.append(img);
    }
    stage.append(overlay(report));
    const viewport = h("div", {
      class: "viewport", tabindex: "0", role: "group",
      "aria-label": `${title}. Drag or use the arrow keys to pan, scroll or + and - to zoom.`,
    }, stage);
    const pane = { title, stage, viewport, imgs, layers };
    wireViewport(pane);
    return { pane, el: h("div", { class: "pane" }, h("h3", { text: title }), viewport) };
  }

  async function renderStage(keepView) {
    const area = $("stage-area");
    const report = state.detail.report;
    const token = ++state.renderToken;
    stopBlink(false);
    state.panes = [];
    if (!report.geometry) {
      area.replaceChildren(h("p", { text: `${report.status}: ${report.message || ""}` }));
      $("mode-controls").replaceChildren();
      return;
    }
    // decode once so the readout works in every mode
    await Promise.all(["reference", "rendered", "diff", "heatmap"].map((n) => loadPixels(imgUrl(n))));
    if (token !== state.renderToken) return; // a newer render superseded this one

    const diffName = state.diffMode;
    const els = [];
    const add = (title, layers) => {
      const { pane, el } = makePane(title, layers, report);
      state.panes.push(pane);
      els.push(el);
      return pane;
    };
    const controls = [];

    if (state.mode === "side") {
      add("Reference", ["reference"]);
      add("Rendered", ["rendered"]);
      add(diffName === "diff" ? "Pixel diff" : "Difference heatmap", [diffName]);
    } else if (state.mode === "swipe") {
      const pane = add("Reference (left) | Rendered (right)", ["reference", "rendered"]);
      const apply = () => (pane.imgs.rendered.style.clipPath = `inset(0 0 0 ${state.swipe}%)`);
      apply();
      controls.push(slider("Swipe position", state.swipe, (v) => { state.swipe = v; apply(); }));
    } else if (state.mode === "onion") {
      const pane = add("Onion skin: rendered over reference", ["reference", "rendered"]);
      const apply = () => (pane.imgs.rendered.style.opacity = state.onion / 100);
      apply();
      controls.push(slider("Rendered opacity", state.onion, (v) => { state.onion = v; apply(); }));
    } else if (state.mode === "blink") {
      const pane = add("Blink: reference / rendered", ["reference", "rendered"]);
      state.blinkPane = pane;
      applyBlink();
      controls.push(
        h("button", { type: "button", id: "blink-toggle", "aria-pressed": "false", onclick: () => (state.blinkTimer ? stopBlink(true) : startBlink()), text: "Blink (b)" }),
        h("output", { id: "blink-which", "aria-live": "polite" })
      );
      showBlinkLabel();
    } else if (state.mode === "live") {
      add("Reference", ["reference"]);
      const c = state.detail.case;
      const frame = h("iframe", {
        title: `Live HTML for ${c.id}`, src: `/fixture/${encodeURIComponent(c.id)}?v=${state.version}`,
        width: Math.ceil(c.logicalSize.width), height: Math.ceil(c.logicalSize.height),
      });
      els.push(h("div", { class: "live" },
        h("h3", { text: "Live HTML (drag the corner to resize the frame and check responsive behaviour)" }),
        h("div", { class: "frame" }, frame)));
      controls.push(
        h("a", { href: `/fixture/${encodeURIComponent(c.id)}`, target: "_blank", rel: "noopener", text: "Open in a new tab" }),
        h("button", { type: "button", onclick: () => (frame.src = frame.src), text: "Reload frame" })
      );
    }

    area.replaceChildren(...els);
    $("mode-controls").replaceChildren(...controls);
    if (keepView && state.viewSet) applyView();
    else fit();
    showReadout(null);
  }

  function slider(label, value, onInput) {
    const input = h("input", { type: "range", min: "0", max: "100", value: String(value), id: "range-" + label.replace(/\W/g, "") });
    input.addEventListener("input", () => onInput(Number(input.value)));
    return h("label", {}, label + " ", input);
  }

  // ---------------------------------------------------------------- blink
  function applyBlink() {
    const pane = state.blinkPane;
    if (!pane) return;
    pane.imgs.reference.style.visibility = state.blinkShowRendered ? "hidden" : "visible";
    pane.imgs.rendered.style.visibility = state.blinkShowRendered ? "visible" : "hidden";
    showBlinkLabel();
  }
  function showBlinkLabel() {
    const out = $("blink-which");
    if (out) out.textContent = state.blinkShowRendered ? "showing: rendered" : "showing: reference";
  }
  function startBlink() {
    if (state.mode !== "blink") return;
    state.blinkTimer = setInterval(() => { state.blinkShowRendered = !state.blinkShowRendered; applyBlink(); }, 600);
    $("blink-toggle")?.setAttribute("aria-pressed", "true");
  }
  function stopBlink(update) {
    clearInterval(state.blinkTimer);
    state.blinkTimer = null;
    if (update) $("blink-toggle")?.setAttribute("aria-pressed", "false");
  }

  // ---------------------------------------------------------------- zoom / pan
  function applyView() {
    const { z, x, y } = state.view;
    for (const pane of state.panes) {
      pane.stage.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      pane.stage.classList.toggle("pixelated", z >= 1);
    }
    $("zoom-level").textContent = Math.round(z * 100) + "%";
  }

  function imageSize() {
    const g = state.detail.report.geometry.cropPx;
    return { w: g.w, h: g.h };
  }

  function fit() {
    const pane = state.panes[0];
    if (!pane || !state.detail.report.geometry) return;
    const { w, h: ih } = imageSize();
    const vw = pane.viewport.clientWidth - 16, vh = pane.viewport.clientHeight - 16;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, vw / w, vh / ih));
    state.view = { z, x: (pane.viewport.clientWidth - w * z) / 2, y: (pane.viewport.clientHeight - ih * z) / 2 };
    state.viewSet = false;
    applyView();
  }

  function zoomAt(factor, cx, cy) {
    const v = state.view;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.z * factor));
    const ix = (cx - v.x) / v.z, iy = (cy - v.y) / v.z;
    state.view = { z, x: cx - ix * z, y: cy - iy * z };
    state.viewSet = true;
    applyView();
  }

  function zoomCenter(factor) {
    const p = state.panes[0];
    if (p) zoomAt(factor, p.viewport.clientWidth / 2, p.viewport.clientHeight / 2);
  }

  function pan(dx, dy) {
    state.view = { ...state.view, x: state.view.x + dx, y: state.view.y + dy };
    state.viewSet = true;
    applyView();
  }

  function wireViewport(pane) {
    const vp = pane.viewport;
    vp.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    let drag = null;
    vp.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY };
      vp.setPointerCapture(e.pointerId);
    });
    vp.addEventListener("pointermove", (e) => {
      if (drag) {
        pan(e.clientX - drag.x, e.clientY - drag.y);
        drag = { x: e.clientX, y: e.clientY };
      }
      showReadout(pane, e);
    });
    vp.addEventListener("pointerup", () => (drag = null));
    vp.addEventListener("pointerleave", () => showReadout(null));
    vp.addEventListener("keydown", (e) => {
      const d = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key];
      if (d) { e.preventDefault(); pan(...d); }
    });
  }

  function selectCluster(i) {
    const r = state.detail.report;
    if (!r.clusters || !r.clusters[i]) return;
    state.selectedCluster = i;
    $("show-clusters").checked = true;
    const c = r.clusters[i], g = r.geometry.cropPx, p = state.panes[0];
    if (p) {
      const bx = c.x * r.scale + g.margin, by = c.y * r.scale + g.margin, bw = c.w * r.scale, bh = c.h * r.scale;
      const z = Math.max(1, Math.min(MAX_ZOOM, 0.5 * Math.min(p.viewport.clientWidth / bw, p.viewport.clientHeight / bh)));
      state.view = { z, x: p.viewport.clientWidth / 2 - (bx + bw / 2) * z, y: p.viewport.clientHeight / 2 - (by + bh / 2) * z };
      state.viewSet = true;
    }
    renderClusters(r);
    refreshOverlays();
    applyView();
    say(`Cluster ${i + 1} of ${r.clusters.length}`);
  }

  function refreshOverlays() {
    const report = state.detail && state.detail.report;
    if (!report || !report.geometry) return;
    for (const pane of state.panes) pane.stage.querySelector("svg").replaceWith(overlay(report));
  }

  // ---------------------------------------------------------------- pixel readout
  function showReadout(pane, e) {
    const out = $("readout");
    if (!pane || !e || !state.detail || !state.detail.report.geometry) {
      out.textContent = "Move the pointer over an image to read pixels.";
      return;
    }
    const r = state.detail.report;
    const rect = pane.viewport.getBoundingClientRect();
    const ix = Math.floor((e.clientX - rect.left - state.view.x) / state.view.z);
    const iy = Math.floor((e.clientY - rect.top - state.view.y) / state.view.z);
    const g = r.geometry.cropPx;
    if (ix < 0 || iy < 0 || ix >= g.w || iy >= g.h) {
      out.textContent = "Outside the image.";
      return;
    }
    const read = (name) => {
      const px = state.pixels[imgUrl(name)];
      if (!px) return null;
      const i = (iy * px.width + ix) * 4;
      return [px.data[i], px.data[i + 1], px.data[i + 2]];
    };
    const ref = read("reference"), rend = read("rendered"), third = read(state.diffMode);
    const sw = (c) => (c ? h("span", {}, h("i", { class: "sw", style: `background:${hex(c)}` }), hex(c)) : "-");
    const delta = ref && rend ? Math.max(...ref.map((v, k) => Math.abs(v - rend[k]))) : "-";
    out.replaceChildren(
      `image px ${ix},${iy}  ·  css px from window top-left ${((ix - g.margin) / r.scale).toFixed(1)},${((iy - g.margin) / r.scale).toFixed(1)}\n`,
      "reference ", sw(ref), "   rendered ", sw(rend), `   ${state.diffMode} `, sw(third), `   max channel Δ ${delta}`
    );
  }

  // ---------------------------------------------------------------- actions
  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    document.querySelector(`input[name=mode][value=${mode}]`).checked = true;
    if (state.detail) renderStage(true);
  }

  function toggleDiffMode() {
    state.diffMode = state.diffMode === "diff" ? "heatmap" : "diff";
    $("diff-mode").value = state.diffMode;
    if (state.detail) renderStage(true);
  }

  async function rerender() {
    if (!state.id) return;
    const button = $("rerender");
    button.disabled = true;
    say("Rendering…");
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(state.id)}/render`, { method: "POST", headers: { "X-Requested-With": "pane-qa" } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.status);
      say("Re-rendered.");
      await loadList();
      await loadDetail();
    } catch (err) {
      say("Render failed: " + err.message);
    } finally {
      button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    for (const id of ["f-os", "f-theme", "f-view", "f-status"]) $(id).addEventListener("change", renderList);
    document.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", () => setMode(r.value)));
    $("diff-mode").addEventListener("change", (e) => { state.diffMode = e.target.value; if (state.detail) renderStage(true); });
    $("show-masks").addEventListener("change", refreshOverlays);
    $("show-clusters").addEventListener("change", refreshOverlays);
    $("zoom-in").addEventListener("click", () => zoomCenter(1.25));
    $("zoom-out").addEventListener("click", () => zoomCenter(0.8));
    $("zoom-fit").addEventListener("click", fit);
    $("rerender").addEventListener("click", rerender);
    $("help-button").addEventListener("click", () => $("help").showModal());
    window.addEventListener("resize", () => { if (!state.viewSet) fit(); });

    document.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t.matches && t.matches("select, textarea, input[type=text]")) return;
      if ($("help").open) return;
      const key = e.key;
      const modes = { 1: "side", 2: "swipe", 3: "onion", 4: "blink", 5: "live" };
      if (key === "j") step(1);
      else if (key === "k") step(-1);
      else if (modes[key]) setMode(modes[key]);
      else if (key === "h") toggleDiffMode();
      else if (key === "m") { $("show-masks").click(); }
      else if (key === "c") { $("show-clusters").click(); }
      else if (key === "b") { if (state.mode !== "blink") setMode("blink"); state.blinkTimer ? stopBlink(true) : startBlink(); }
      else if (key === "+" || key === "=") zoomCenter(1.25);
      else if (key === "-") zoomCenter(0.8);
      else if (key === "0") fit();
      else if (key === "]") selectCluster(Math.min((state.selectedCluster + 1), (state.detail?.report.clusters?.length || 1) - 1));
      else if (key === "[") selectCluster(Math.max(state.selectedCluster - 1, 0));
      else if (key === "r") rerender();
      else if (key === "?") $("help").showModal();
      else return;
      if (key !== "+" && key !== "-") e.preventDefault();
    });

    const events = new EventSource("/events");
    events.onmessage = async (msg) => {
      const data = JSON.parse(msg.data);
      if (!state.sseReady) { // the first message only announces the current version
        state.sseReady = true;
        return;
      }
      const isFixture = typeof data.what === "string" && data.what.endsWith(".html");
      await loadList();
      if (isFixture && $("auto-render").checked) return rerender();
      await loadDetail();
      say("Reloaded (files changed).");
    };
  }

  async function init() {
    wire();
    await loadList();
    const first = decodeURIComponent(location.hash.slice(1));
    select(state.cases.some((c) => c.id === first) ? first : (state.cases[0] || {}).id);
  }
  init().catch((err) => say(err.message));
})();
