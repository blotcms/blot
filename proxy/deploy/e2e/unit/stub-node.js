// Stands in for node-a and node-b in the unit stand-in image: answers 200 to
// everything on BLOT_SOCKET and BLOT_WORKER_SOCKET. STUB_BREAK=a leaves node-a
// out, so a unit made from it never becomes healthy.
const http = require("http");
const fs = require("fs");

const sockets = [process.env.BLOT_SOCKET, process.env.BLOT_WORKER_SOCKET];
if (process.env.STUB_BREAK === "a") sockets.shift();

for (const socket of sockets) {
  fs.rmSync(socket, { force: true });
  http
    .createServer((req, res) => res.end("ok"))
    .listen(socket, () => fs.chmodSync(socket, 0o666));
}
