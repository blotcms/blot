#!/usr/bin/env node
// node app/helper/pane/qa [--port 4173]  ->  http://127.0.0.1:4173
const { createServer } = require("./server");
const { parseArgs } = require("./lib/args");

const args = parseArgs(process.argv.slice(2));
const port = parseInt(args.port || process.env.PORT || "4173", 10);
const app = createServer();
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`pane QA viewer: http://127.0.0.1:${port}`);
});
process.on("SIGINT", async () => {
  server.close();
  await app.close();
  process.exit(0);
});
