const express = require("express");
const app = express();

// A 1x1 transparent PNG. Kept inline so the upstream stub has no native
// dependency (the cacher specs only need a small binary body to prove the
// cache is byte-safe).
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

app.get("/", (req, res) => {
  res.send("Hello Node!");
});

// dynamic route
app.use("/timestamp", (req, res) => {
  res.send(`${Date.now()}`);
});

app.use("/gzip", (req, res) => {
  res.send("abc ".repeat(1024));
});

// large-ish body to check the cache stores binary responses intact
app.use("/blob", (req, res) => {
  const size = parseInt(req.query.size, 10) || 256 * 1024;
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = i % 256;
  res.set("Content-Type", "application/octet-stream");
  res.send(buf);
});

app.get("/:filename.png", (req, res) => {
  res.set("Content-Type", "image/png");
  res.send(PNG_1x1);
});

module.exports = ({ port }) => {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      resolve(server);
    });
  });
};
