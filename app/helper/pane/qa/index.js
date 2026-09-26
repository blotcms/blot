#!/usr/bin/env node
// node app/helper/pane/qa [--port 4173]  ->  http://127.0.0.1:4173
// Without --port (or PORT), the next free port is used if 4173 is taken.
const { createServer } = require("./server");
const { parseArgs } = require("./lib/args");

const args = parseArgs(process.argv.slice(2));
const explicit = args.port || process.env.PORT;
let port = parseInt(explicit || "4173", 10);
const app = createServer();

function listen() {
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`pane QA viewer: http://127.0.0.1:${port}`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !explicit && port < 4273) {
      port++;
      return listen();
    }
    if (err.code === "EADDRINUSE") console.error(`Port ${port} is in use; pass a different --port.`);
    else console.error(err);
    process.exit(1);
  });
  process.once("SIGINT", async () => {
    server.close();
    await app.close();
    process.exit(0);
  });
}
listen();
