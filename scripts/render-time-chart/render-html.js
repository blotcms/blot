const LINE_COLOR = "#3b82f6";

// Two standalone charts sharing one drawing routine: the last 24h at
// one-minute resolution, and the all-time history at one-point-per-day
// resolution. Data is embedded as JSON and drawn with plain SVG + a small
// inline script - no external assets or CDN scripts, so the file works
// offline and can be shared as-is.
function renderHTML({ last24h, allTimeDaily }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Blot p95 render time</title>
<style>
  body { font: 14px -apple-system, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.1rem; margin: 2rem 0 0.5rem; }
  h1:first-of-type { margin-top: 0; }
  svg.chart { width: 100%; height: 320px; }
  .empty { color: #888; }
  .tooltip {
    position: absolute; pointer-events: none; background: #1a1a1a; color: #fff;
    padding: 4px 8px; border-radius: 4px; font-size: 12px; opacity: 0; transition: opacity 0.1s;
  }
</style>
</head>
<body>
<h1>p95 page render time - last 24h (5 min resolution)</h1>
<div id="chart-24h"></div>
<h1>p95 page render time - all time (1 day resolution)</h1>
<div id="chart-all-time"></div>
<div class="tooltip" id="tooltip"></div>
<script>
const DATA = ${JSON.stringify({ last24h, allTimeDaily })};
const COLOR = ${JSON.stringify(LINE_COLOR)};
const tooltip = document.getElementById("tooltip");

function timeLabel(t, allTime) {
  return allTime
    ? new Date(t).toLocaleDateString([], { month: "short", day: "numeric" })
    : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function drawChart(container, points, { allTime }) {
  if (points.length === 0) {
    container.innerHTML = '<p class="empty">No data yet.</p>';
    return;
  }

  const width = container.clientWidth || 900;
  const height = 320;
  const margin = { top: 20, right: 20, bottom: 30, left: 50 };

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "chart");
  svg.setAttribute("viewBox", \`0 0 \${width} \${height}\`);
  container.appendChild(svg);

  const sorted = points.slice().sort((a, b) => a.timestampMs - b.timestampMs);
  const xMin = sorted[0].timestampMs;
  const xMax = sorted[sorted.length - 1].timestampMs;
  const yMax = Math.max(...sorted.map((p) => p.p95Ms)) * 1.1 || 1;

  const x = (t) =>
    margin.left + ((t - xMin) / (xMax - xMin || 1)) * (width - margin.left - margin.right);
  const y = (v) =>
    height - margin.bottom - (v / yMax) * (height - margin.top - margin.bottom);

  function svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const v = (yMax / ySteps) * i;
    svg.appendChild(
      svgEl("line", { x1: margin.left, x2: width - margin.right, y1: y(v), y2: y(v), stroke: "#eee" })
    );
    const label = svgEl("text", { x: margin.left - 8, y: y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "#666" });
    label.textContent = Math.round(v) + "ms";
    svg.appendChild(label);
  }

  [xMin, (xMin + xMax) / 2, xMax].forEach((t) => {
    const label = svgEl("text", { x: x(t), y: height - margin.bottom + 18, "text-anchor": "middle", "font-size": 11, fill: "#666" });
    label.textContent = timeLabel(t, allTime);
    svg.appendChild(label);
  });

  const path = sorted.map((p, i) => \`\${i === 0 ? "M" : "L"}\${x(p.timestampMs)},\${y(p.p95Ms)}\`).join(" ");
  svg.appendChild(svgEl("path", { d: path, fill: "none", stroke: COLOR, "stroke-width": 2 }));

  sorted.forEach((p) => {
    const dot = svgEl("circle", { cx: x(p.timestampMs), cy: y(p.p95Ms), r: allTime ? 2 : 2.5, fill: COLOR });
    dot.addEventListener("mouseenter", (e) => {
      tooltip.style.opacity = 1;
      tooltip.style.left = e.pageX + 12 + "px";
      tooltip.style.top = e.pageY - 12 + "px";
      tooltip.textContent = \`\${p.p95Ms}ms at \${timeLabel(p.timestampMs, allTime)}\`;
    });
    dot.addEventListener("mouseleave", () => (tooltip.style.opacity = 0));
    svg.appendChild(dot);
  });
}

drawChart(document.getElementById("chart-24h"), DATA.last24h, { allTime: false });
drawChart(document.getElementById("chart-all-time"), DATA.allTimeDaily, { allTime: true });
</script>
</body>
</html>
`;
}

module.exports = { renderHTML };
