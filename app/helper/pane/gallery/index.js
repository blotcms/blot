#!/usr/bin/env node
// node app/helper/pane/gallery [--port 8040]  ->  http://127.0.0.1:8040
const { createServer } = require("./server");
const { parseArgs } = require("../qa/lib/args");

const args = parseArgs(process.argv.slice(2));
const port = parseInt(args.port || process.env.PORT || "8040", 10);
const app = createServer();

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`pane gallery: http://127.0.0.1:${port}`);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE")
    console.error(`Port ${port} is in use; pass a different --port.`);
  else console.error(err);
  process.exit(1);
});
process.once("SIGINT", () => {
  server.close();
  app.close();
  process.exit(0);
});
