import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";

// Read only Codex's structured listing; do not print MCP environments or secrets.
try {
  const servers = JSON.parse(readFileSync(0, "utf8"));
  const server = servers.find(server => server.name === "agentation");
  const transport = server?.transport;
  const args = transport?.args;
  const valid = server?.enabled === true && transport?.type === "stdio" &&
    basename(transport.command) === "bash" && Array.isArray(args) &&
    args.length === 2 && args[1] === "mcp" &&
    realpathSync(args[0]) === realpathSync(process.argv[2]);
  if (!valid) process.exitCode = 1;
} catch {
  // A stale path, invalid JSON or unsupported listing is a failed preflight.
  process.exitCode = 1;
}
