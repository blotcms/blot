# Agentation → Codex (local development)

Register MCP once from the main checkout, then start development normally:

```sh
codex mcp add agentation -- bash "$(pwd)/scripts/development/agentation/run.sh" mcp
npm start
```

**Restart Codex after registration.** No additional skills or API keys are needed.
`npm start` checks `codex mcp list --json`, then starts Agentation automatically.
Missing, disabled, or stale registrations stop startup with the command to fix them;
rerun registration after moving the checkout or updating from the old script path.
Requires Codex CLI, Docker Compose v2 and Node 24.22.1 (LTS).

In the browser, expand the toolbar, select an element and save a note. Ask Codex
to call `agentation_get_all_pending`, or `agentation_watch_annotations` for ongoing
feedback. No prompt copying is needed. Ctrl+C runs Agentation's `down` command,
then stops the stack; annotations persist.

`AGENTATION_PORT` optionally changes the loopback port (8477).
To disable Agentation while leaving Blot running:
`bash scripts/development/agentation/run.sh down` (reload pages afterward).
The next `npm start` enables it again. [Details](REFERENCE.md).
