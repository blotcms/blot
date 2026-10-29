// Stub upstream for the proxy cache benchmark. Content is generated once at
// startup from a fixed seed, so every run (and both proxies) serve identical
// bytes.
const http = require("http");
const zlib = require("zlib");

// mulberry32: tiny seeded PRNG
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(20261023);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// A few hundred pseudo-English words built from syllables
const SYL = ["ta","ro","men","di","pla","ke","sun","lo","vi","cra","ber","an","tho","gle","mi","ster","po","han","du","fel","ni","wor","ca","ble","ex","ti","ma","rin","sol","ul"];
const WORDS = [];
while (WORDS.length < 400) {
  let w = "";
  const n = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < n; i++) w += pick(SYL);
  if (!WORDS.includes(w)) WORDS.push(w);
}

// Skewed pick so common words repeat the way real prose does
const word = () => WORDS[Math.floor(Math.pow(rand(), 2.2) * WORDS.length)];

function sentence() {
  const n = 6 + Math.floor(rand() * 14);
  const parts = [];
  for (let i = 0; i < n; i++) {
    let w = word();
    const r = rand();
    if (r < 0.05) w = `<em>${w}</em>`;
    else if (r < 0.08) w = `<strong>${w}</strong>`;
    else if (r < 0.1) w = `<a href="/${word()}/${word()}-${Math.floor(rand() * 1000)}">${w}</a>`;
    parts.push(w);
  }
  const s = parts.join(" ");
  return s[0].toUpperCase() + s.slice(1) + ".";
}

function paragraph() {
  const n = 3 + Math.floor(rand() * 5);
  const s = [];
  for (let i = 0; i < n; i++) s.push(sentence());
  return `<p>${s.join(" ")}</p>\n`;
}

function html(target) {
  let out = `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>${word()} ${word()}</title>` +
    `<link rel="stylesheet" href="/style.css"></head><body>\n<header><h1>${word()} ${word()}</h1></header>\n<main>\n`;
  while (out.length < target) {
    if (rand() < 0.15) out += `<h2>${word()} ${word()} ${word()}</h2>\n`;
    out += paragraph();
  }
  return out + "</main>\n<footer><p>" + sentence() + "</p></footer></body></html>\n";
}

const page = Buffer.from(html(60 * 1024));
const large = Buffer.from(html(2 * 1024 * 1024));
const image = Buffer.alloc(200 * 1024);
for (let i = 0; i < image.length; i++) image[i] = Math.floor(rand() * 256);

console.log(
  `page ${page.length} B (gzip ${(page.length / zlib.gzipSync(page, { level: 5 }).length).toFixed(2)}x), ` +
  `large ${large.length} B (gzip ${(large.length / zlib.gzipSync(large, { level: 5 }).length).toFixed(2)}x), ` +
  `image ${image.length} B`
);

const routes = {
  "/page": ["text/html; charset=utf-8", page],
  "/large": ["text/html; charset=utf-8", large],
  "/image.jpg": ["image/jpeg", image],
};

const server = http.createServer((req, res) => {
  const r = routes[req.url.split("?")[0]];
  if (!r) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": r[0], "Content-Length": r[1].length });
  res.end(r[1]);
});
// Node closes idle keep-alive connections after 5s, which races with nginx
// reusing one ("upstream prematurely closed connection"); stay open longer
server.keepAliveTimeout = 65000;
server.listen(8090, "0.0.0.0");
