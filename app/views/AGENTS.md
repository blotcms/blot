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

## Local development and verification

- Use `https://local.blot/` to verify rendered changes in the browser.
- If `https://local.blot/` is offline or unreachable, stop and prompt the operator to run `npm start`. Do not silently substitute another server or continue browser verification against a different URL.
- After editing a view, wait for the documentation watcher/server to reload before checking the page.
- Reload the relevant browser page and confirm the changed text or layout is visibly present before reporting success.
- When useful, inspect the running containers with `docker ps`. The node container is currently named `blot-node-app-1`; its logs can be followed with `docker logs -f --tail 0 blot-node-app-1`.

## Editing guidance

- Keep changes focused on the requested brochure/documentation behavior or presentation.
- Preserve unrelated worktree changes; do not reset, discard, or overwrite them.
- Prefer editing the source view in `app/views` rather than generated or cached output.
- Do not claim that a change works based only on a successful file edit; verify it through the local site.
