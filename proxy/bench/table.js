// Turns run.sh's tab separated results into a markdown comparison table.
const fs = require("fs");
const [file, work] = process.argv.slice(2);
// impl, case, rps, p50, p99, xfer, non2xx, reqs, socket errors, cpu/req, proxy cores, wrk cores, stub cores
const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => l.split("\t"));
const cases = [...new Set(rows.map((r) => r[1]))];
const get = (impl, c) => rows.find((r) => r[0] === impl && r[1] === c);

const cell = (r) => (r ? r : []);
console.log("| Case | Impl | req/s | p50 ms | p99 ms | transfer/s | non-2xx | CPU us/req | proxy cores | wrk cores | stub cores |");
console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const c of cases) {
  for (const impl of ["proxycache", "diskcache"]) {
    const r = cell(get(impl, c));
    console.log(`| ${c} | ${impl} | ${r[2]} | ${r[3]} | ${r[4]} | ${r[5]} | ${r[6]}${r[8] ? " (" + r[8].trim() + ")" : ""} | ${r[9]} | ${r[10]} | ${r[11]} | ${r[12]} |`);
  }
}
console.log("\nRatio diskcache / proxycache:\n");
console.log("| Case | req/s | CPU us/req |");
console.log("| --- | ---: | ---: |");
for (const c of cases) {
  const a = get("proxycache", c), b = get("diskcache", c);
  console.log(`| ${c} | ${(b[2] / a[2]).toFixed(2)}x | ${(b[9] / a[9]).toFixed(2)}x |`);
}
const bro = `${work}/brotli.tsv`;
if (fs.existsSync(bro) && fs.readFileSync(bro, "utf8").trim()) {
  console.log("\nCPU time of one brotli compression, run in the proxy container (what the compressor pays once per entry read twice):\n");
  console.log("| Page | Size | Level | Compressed | CPU ms |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const l of fs.readFileSync(bro, "utf8").trim().split("\n")) {
    const [p, size, q, out, us] = l.split("\t");
    console.log(`| ${p} | ${size} | ${q} | ${out} | ${(us / 1000).toFixed(1)} |`);
  }
}
console.log("\nResponse checks (Blot-Cache HIT, or MISS for fill cases, and expected Content-Encoding, before each wrk run):\n");
for (const impl of ["proxycache", "diskcache"]) {
  const p = `${work}/checks-${impl}.tsv`;
  const lines = fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").map((l) => l.split("\t")) : [];
  console.log(`- ${impl}: ${lines.map(([n, f]) => `${n} ${f}`).join(", ")}`);
}
console.log("\nProxy error/crit/alert log lines:\n");
for (const impl of ["proxycache", "diskcache"]) {
  const p = `${work}/errors-${impl}.txt`;
  const t = fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
  console.log(`- ${impl}: ${t ? "\n\n```\n" + t.split("\n").slice(0, 10).join("\n") + "\n```\n" : "none"}`);
}
