import { startHttpServer } from "agentation-mcp";

// HTTP only: the MCP client launches its own --mcp-only stdio adapter.
startHttpServer(8477);
