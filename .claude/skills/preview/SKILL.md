---
name: preview
description: Run this git worktree's code in its own local server at https://slot-local.blot (slots a-e) so the operator can see and click through it while the main stack keeps running. Use when the operator asks to preview, show, or let them try the current changes, or to "set up a preview" for a worktree.
---

# Preview this worktree

`https://local.blot` serves the main checkout, never a worktree. Do not ask the
operator to check the branch out; use a preview slot. Design and limits:
`scripts/development/worktrees.md`.

1. Work out the page the operator should look at: the docs page, template
   preview, dashboard page, or brochure page related to the task. Prefer the
   `https://local.blot/...` URL of that page; `preview.sh` rewrites it to the
   slot host.
2. From the worktree run:

   ```bash
   scripts/development/preview.sh up <url-or-path>
   ```

   If it prints a WARNING that nginx has no preview routing, stop and tell the
   operator to update the main checkout to current `master` and restart nginx.
   If `https://local.blot` is down it refuses; ask the operator to run `npm start`.
   When the command runs inside a sandbox, its health check may be unable to
   reach an otherwise-running `local.blot`; retry with host access when the
   environment supports it before concluding that the main stack is offline.
3. Give the operator the printed **Login** URL (one-time, opens the dashboard)
   and the **Work** URL, as clickable links. Use `blot-node-<slot>` in place of
   `blot-node-app-1` for any `docker exec`.
   `local.blot` is the main checkout; `<slot>-local.blot` (for example,
   `b-local.blot`) is the worktree preview. If Firefox reports that the host
   cannot be found and mentions `mozilla.cloudflare-dns.com`, Secure DNS / DNS
   over HTTPS is bypassing the local resolver. Have the operator choose
   **Always continue for this site** or disable Secure DNS/use the system
   resolver, then reload the printed URL.
4. Edits to files in this worktree show up on the slot within seconds. Dashboard
   changes (site settings, template edits) are written to the shared dev
   database and also show on `local.blot`.
5. Do not use a slot to test sync, the scheduler or Redis-schema changes; only
   the main stack runs those. SITE-template edits (`app/templates/source`) do
   rebuild on a slot, but write to the shared dev Redis, so they also show on
   `local.blot`.
6. When the task is finished or the operator is done, run
   `scripts/development/preview.sh down` to release the slot (`preview.sh ls`
   shows who holds each one).

## Local Agentation feedback

`npm start` enables the `scripts/development/agentation/` overlay, which adds a DOM annotation toolbar to local
pages without changing application views. See `scripts/development/agentation/README.md` for
startup, MCP registration, shutdown and persistence. A running HTTP server does
not prove browser delivery: save a recognizable annotation and retrieve it using
`agentation_get_all_pending`, checking its comment, URL and `elementPath`.

Trace feedback from the hostname and path before editing a view:

| Local URL | Router trace | Source to inspect |
| --- | --- | --- |
| `https://local.blot/` and brochure/docs paths | `app/server.js` dispatches the configured host to `app/site/index.js`; documentation is mounted at `/` and resolved by `app/documentation/index.js` | Homepage `app/views/index.html`; other brochure views under `app/views/` |
| `https://local.blot/sites/...` | Site router mounts `app/dashboard/index.js`; `/:handle` dispatches to `app/dashboard/site/` | Mustache views under `app/views/dashboard/` |
| `https://preview-of-<template>-on-<handle>.local.blot/...` | Server catch-all dispatches to `app/blog/index.js`, then `app/blog/middleware/vhosts.js`, then blog entry/view routes | Resolved `SITE:<template>` source under `app/templates/source/<template>/`; inspect its `package.json` view URL/partials overrides |
| `https://preview-of-my-<template>-on-<handle>.local.blot/...` | Same catch-all and virtual-host middleware, resolving the owner from the blog | Resolved `<blogID>:<template>` fork and configured views; do not assume the built-in source is responsible |

For a worktree slot, substitute its configured host (e.g. `a-local.blot`). Follow
the middleware's actual template resolution and any view override. Search for
the annotation's visible text, classes and DOM selector in the likely views and
partials; a URL can render several partials and does not imply one source file.
Read the applicable `AGENTS.md` before editing views or template source. Use
`agentation_get_session` for full context, acknowledge feedback when beginning
work and resolve it with a description of the completed change.
