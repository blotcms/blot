const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { fetchRenderTimeData } = require("./fetch-data");
const { renderHTML } = require("./render-html");

const OUT_DIR = path.join(__dirname, "out");
const OUT_FILE = path.join(OUT_DIR, "render-time.html");

async function main() {
  console.log("Fetching p95 render time from production (ssh blot, read-only)...");

  const data = await fetchRenderTimeData();
  console.log(
    `Got ${data.last24h.length} points for the last 24h, ${data.allTimeDaily.length} daily points all-time.`
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, renderHTML(data));
  console.log(`Wrote ${OUT_FILE}`);

  if (process.platform === "darwin") {
    spawn("open", [OUT_FILE], { stdio: "ignore" }).unref();
  } else {
    console.log("Open this file in a browser to view the chart.");
  }
}

main().catch((err) => {
  console.error("Failed to build render time chart:", err.message);
  process.exit(1);
});
