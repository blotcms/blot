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
5. Do not use a slot to test sync, the scheduler, SITE-template builds
   (`app/templates/source`) or Redis-schema changes; only the main stack runs
   those.
6. When the task is finished or the operator is done, run
   `scripts/development/preview.sh down` to release the slot (`preview.sh ls`
   shows who holds each one).
