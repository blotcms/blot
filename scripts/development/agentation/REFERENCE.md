# Local Agentation

Toolbar and MCP server for Blot's server-rendered pages, enabled by `npm start`.
Requires Codex CLI, Node 24.22.1 (LTS) on the host, and Docker Compose v2. Run from the main
checkout, whose proxy also serves worktree preview slots.

## Start and stop

Register Codex first using the command in the README, restart Codex, then run
`npm start`. Its preflight calls `run.sh check` before TLS setup, background
processes or Docker changes. `codex mcp list --json` must report an enabled stdio
server named `agentation`, running Bash with this checkout's `run.sh mcp`.
Missing Codex, unreadable configuration, disabled entries and stale paths stop
startup with a registration command. Rerun registration after moving the checkout
or upgrading from `scripts/agentation/`.

After the normal stack starts, `npm start` calls `run.sh up`, which checks Codex
again, builds the pinned packages, generates Nginx config from the current
development config, starts the HTTP service and recreates Nginx with its mounts.
Ctrl+C or startup failure runs `run.sh down` before stopping the rest of the stack
and folder opener; annotation volumes are retained. Cleanup is installed before
startup so failed builds are covered.

To temporarily disable Agentation with the app still running:

```sh
bash scripts/development/agentation/run.sh down
```

This restores the original Nginx configuration and stops Agentation. Reload open
pages. `npm start` enables it again next time. You can also run `run.sh up` to
reenable it on an already-running stack. The standalone tool does not start or
reconfigure the application's dependencies. `down` and `mcp` do not check Codex
registration, so shutdown works without Codex and the adapter avoids recursion.

Use the same `BLOT_HOST` as the normal stack (default `local.blot`). The optional
`AGENTATION_PORT` changes only the loopback HTTP port, e.g.:

```sh
BLOT_HOST=localhost AGENTATION_PORT=8478 bash scripts/development/agentation/run.sh up
```

The container always uses 8477; the existing Toxiproxy port 8474 is untouched.
No host npm install is needed. For a managed environment that requires an extra
certificate, pass Docker's optional `proxy_ca` build secret through a local
Compose override using `AGENTATION_COMPOSE_OVERRIDE=/absolute/path/override.yml`.
The override is also applied by `down`, so keep it set for both commands.
Normal local builds do not need that secret. Preserve your environment's Docker proxy configuration.

## Connect an MCP client

Before starting development, register a stdio command in Codex using an absolute
checkout path. For Codex CLI, from the checkout:

```sh
codex mcp add agentation -- bash "$(pwd)/scripts/development/agentation/run.sh" mcp
```

Other clients can use the same stdio command, in addition to the Codex entry
required by startup. For example (replace the path):

```json
{
  "mcpServers": {
    "agentation": {
      "command": "bash",
      "args": ["/absolute/path/to/blot/scripts/development/agentation/run.sh", "mcp"]
    }
  }
}
```

Reload the client's MCP servers after registering. This starts a disposable
Docker stdio adapter using `server --mcp-only --http-url http://agentation:8477`.
It talks to the already-running HTTP container; it does not start a second API.
No TTY is allocated. Docker lifecycle messages go to stderr.

Expand the toolbar, click an element, and save a recognizable comment. Ask the
agent to call `agentation_get_all_pending`, then confirm the exact comment,
page URL, and `elementPath`. A health check alone does not prove delivery.
Use `agentation_get_session` for full page context; resolve completed feedback
with `agentation_resolve`. See the repository's preview skill for source tracing.

## Routing and state

The generated config preserves the normal proxy's upstreams, CDN and slot routing.
Only `BLOT_HOST`, its subdomains and `a-local.blot` through `e-local.blot` (and
their subdomains) receive the toolbar. CDN hosts and unrelated hosts are excluded.
HTML must contain a closing `</body>`; JSON, feeds and other content types are
unchanged. Upstream compression is disabled only in application proxy locations
so Nginx can inject the loader.

The bundle includes React, React DOM and Agentation, served locally at
`/__agentation/toolbar.js`. There are no CDN imports. Agentation uses an isolated
React root to annotate the existing DOM. In 3.1.2, React-tree inspection is gated
by `process.env.NODE_ENV`; compiling the toolbar with `"production"` disables it
and uses optimized React. This does not enable the toolbar in production Blot.
The proposed `reactComponents` component prop does not exist in this release.

Browser requests use `https://<page-host>/__agentation/api/...`; Nginx strips the
prefix and streams SSE without buffering. It verifies exact same-origin browser
requests before removing Origin on the internal hop. The backend rejects all
direct browser origins (`AGENTATION_CORS_ORIGINS=""`); there is no wildcard CORS.
The host API binds only `127.0.0.1:${AGENTATION_PORT:-8477}` for local CLI checks.

SQLite is stored at `/root/.agentation/store.db` in the development-only Compose
volume `blot_agentation-state`. Stopping the overlay keeps annotations. To erase
them, stop MCP clients, run `down`, remove the stopped Agentation container, and
explicitly remove that volume. Browser localStorage also retains local feedback;
clear it through the toolbar when needed. Generated files and dependencies are
ignored; annotations and credentials must never be committed.

## Production boundary and verification

The production Dockerfile copies `scripts/`. Root `.dockerignore` therefore
explicitly excludes **`scripts/development/agentation/`** from the build context. Keep this
exclusion when changing the build. Neither the production Dockerfile nor normal
Compose references this overlay. The root package manifest, application source,
templates and normal development proxy remain unchanged. All Agentation runtime
configuration and browser assets live here, outside the production build context.

```sh
# Optional host-side checks (dependencies stay in this directory):
cd scripts/development/agentation
npm ci
npm run build
```

Verify delivery by saving a note in each page type and retrieving it through MCP.
Disable the overlay and reload to confirm the normal proxy is restored.

Upstream references: [installation](https://www.agentation.com/install),
[MCP server and CLI](https://github.com/benjitaylor/agentation/blob/main/mcp/README.md),
[API](https://www.agentation.com/api), and the
[non-React mounting discussion](https://github.com/benjitaylor/agentation/discussions/166).
Pinned versions: Agentation 3.1.2, MCP 1.3.2, React/React DOM 19.3.1, esbuild 0.28.2.
