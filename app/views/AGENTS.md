# Brochure and documentation views

These instructions apply to work on the brochure and its documentation views.

## Scope boundary

- Work only in `app/views/**` and `app/documentation/**`.
- Do not inspect, edit, or modify other paths in the repository.
- Avoid broad repository-wide searches and commands. Use path-scoped searches rooted in these two directories.
- If answering the question requires information outside these directories, ask the operator rather than exploring the rest of the repository.

## How the views are served

- The Express router for the documentation site is `app/documentation/index.js`.
- The brochure and documentation templates, partials, stylesheets, scripts, and assets are in `app/views/**`.
- The brochure homepage is `app/views/index.html` and is served at `https://local.blot/`.
- The documentation router serves static files from the views directory and renders extensionless paths as matching views.
- CSS source files live in `app/views/css/` and alongside their partials in `app/views/partials/`; `app/documentation/build/css.js` collects and minifies them into the generated `documentation.min.css` bundle.
- Client-side documentation JavaScript is bundled and minified with esbuild from `app/views/js/documentation.js` by `app/documentation/build/js.js`, producing the generated `documentation.min.js`; edit the source modules under `app/views/js/` instead.

## Dashboard login

- The dashboard is available at `https://local.blot/sites`.
- With the local Docker environment running, generate a one-time login link for the default user with:

  ```bash
  docker exec blot-node-app-1 node scripts/blog/access.js 'example@example.com'
  ```

- Open the URL printed by the command in the browser. It establishes the authenticated session and redirects to the dashboard.
- If the container or `https://local.blot/` is unavailable, ask the operator to start the local development server before continuing.

## Local development and verification

- Use `https://local.blot/` to verify rendered changes in the browser.
- If `https://local.blot/` is offline or unreachable, stop and prompt the operator to run `npm start`. Do not silently substitute another server or continue browser verification against a different URL.
- If a rendered check is needed, wait for the documentation watcher/server to reload before checking the page.
- After edits, generally just look at the source diff unless you're making a complicated visual change. If the operator flags an issue, reload the relevant `https://local.blot/` page and verify the rendering.
- When useful, inspect the running containers with `docker ps`. The node container is currently named `blot-node-app-1`; its logs can be followed with `docker logs -f --tail 0 blot-node-app-1`.

## Editing guidance

- Keep changes focused on the requested brochure/documentation behavior or presentation.
- Preserve unrelated worktree changes; do not reset, discard, or overwrite them.
- Prefer editing the source view in `app/views` rather than generated or cached output.
- For simple documentation edits, the source diff is sufficient; use the local site to verify complicated visual changes or investigate an operator-reported issue.

## Documentation writing conventions

- In user-facing documentation, use “post” and “posts” rather than internal terms such as “entry” or “entries.”
- Avoid hardcoding post URL examples because the URL depends on the site’s configured link format.
- Treat user-facing docs as product copy: use concise, user-facing language and describe stable behavior rather than internal terminology or configuration-dependent output.

## Documentation code blocks and guide navigation

- Use `<pre class="bash|html|json" data-file="..."><code>…</code></pre>` for copyable code blocks.
- Adjacent code blocks ending in `class="output"` become input → JSON → output tabs.
- Escape literal HTML inside code and avoid leading or trailing blank lines inside `<code>`.
- Developer guide ordering is manual; when renaming a guide, also update its breadcrumb title in `app/documentation/selected.js`.

## Previewing from a worktree

`https://local.blot` serves the main checkout, not a worktree. To let the operator see and click through a worktree's code, run `scripts/development/preview.sh up <url-or-path>` from it, passing the page being worked on (for example a docs page such as `/how/...`, or `https://local.blot/how/...`, which is rewritten to the slot host). Give the operator the printed **Login** URL (one-time, opens the dashboard) and **Work** URL, and use `blot-node-<slot>` for `docker exec`. Run `scripts/development/preview.sh down` when finished. See `scripts/development/worktrees.md`.
