const COLORS = { blue: "#3b82f6", green: "#22c55e", yellow: "#eab308" };

// Standalone page: the data is embedded as JSON and the chart is drawn with
// plain SVG + a small inline script, no external assets or CDN scripts, so
// the file works offline and can be shared as-is.
function renderHTML(data) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Blot p95 render time</title>
<style>
  body { font: 14px -apple-system, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.1rem; }
  #chart { width: 100%; height: 420px; }
  .legend { display: flex; gap: 1.5rem; margin: 0.5rem 0 1.5rem; }
  .legend span { display: inline-flex; align-items: center; gap: 0.4rem; }
  .legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .tooltip {
    position: absolute; pointer-events: none; background: #1a1a1a; color: #fff;
    padding: 4px 8px; border-radius: 4px; font-size: 12px; opacity: 0; transition: opacity 0.1s;
  }
</style>
</head>
<body>
<h1>p95 page render time - last 24h</h1>
<div class="legend" id="legend"></div>
<svg id="chart"></svg>
<div class="tooltip" id="tooltip"></div>
<script>
const DATA = ${JSON.stringify(data)};
const COLORS = ${JSON.stringify(COLORS)};

const svg = document.getElementById("chart");
const legend = document.getElementById("legend");
const tooltip = document.getElementById("tooltip");

const width = svg.clientWidth || 900;
const height = 420;
const margin = { top: 20, right: 20, bottom: 30, left: 50 };
svg.setAttribute("viewBox", \`0 0 \${width} \${height}\`);

const allPoints = Object.values(DATA).flat();

if (allPoints.length === 0) {
  svg.outerHTML = "<p>No render time data found in the last 24h.</p>";
} else {
  const xMin = Math.min(...allPoints.map((p) => p.timestampMs));
  const xMax = Math.max(...allPoints.map((p) => p.timestampMs));
  const yMax = Math.max(...allPoints.map((p) => p.p95Ms)) * 1.1;

  const x = (t) =>
    margin.left + ((t - xMin) / (xMax - xMin || 1)) * (width - margin.left - margin.right);
  const y = (v) =>
    height - margin.bottom - (v / (yMax || 1)) * (height - margin.top - margin.bottom);

  function svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // Y axis gridlines + labels
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

  // X axis labels (start / middle / end)
  [xMin, (xMin + xMax) / 2, xMax].forEach((t) => {
    const label = svgEl("text", { x: x(t), y: height - margin.bottom + 18, "text-anchor": "middle", "font-size": 11, fill: "#666" });
    label.textContent = new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    svg.appendChild(label);
  });

  Object.keys(DATA).forEach((container) => {
    const points = DATA[container].slice().sort((a, b) => a.timestampMs - b.timestampMs);
    if (points.length === 0) return;

    const color = COLORS[container] || "#888";

    const path = points.map((p, i) => \`\${i === 0 ? "M" : "L"}\${x(p.timestampMs)},\${y(p.p95Ms)}\`).join(" ");
    svg.appendChild(svgEl("path", { d: path, fill: "none", stroke: color, "stroke-width": 2 }));

    points.forEach((p) => {
      const dot = svgEl("circle", { cx: x(p.timestampMs), cy: y(p.p95Ms), r: 2.5, fill: color });
      dot.addEventListener("mouseenter", (e) => {
        tooltip.style.opacity = 1;
        tooltip.style.left = e.pageX + 12 + "px";
        tooltip.style.top = e.pageY - 12 + "px";
        tooltip.textContent = \`\${container}: \${p.p95Ms}ms at \${new Date(p.timestampMs).toLocaleTimeString()}\`;
      });
      dot.addEventListener("mouseleave", () => (tooltip.style.opacity = 0));
      svg.appendChild(dot);
    });

    const legendItem = document.createElement("span");
    legendItem.innerHTML = \`<i style="background:\${color}"></i>\${container}\`;
    legend.appendChild(legendItem);
  });
}
</script>
</body>
</html>
`;
}

module.exports = { renderHTML };
