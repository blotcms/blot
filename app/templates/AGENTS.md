# Working on templates

## Scope

- Edit template definitions only under `app/templates/**`.
- Content under `app/templates/folders/**` is combined with specific templates to generate screenshots and production template previews, so treat changes to these folder fixtures as production-affecting.
- `data/blogs/<blog-id>/**` is also in scope, but only for the identified dashboard site; it contains that site’s source-folder files.
- Read `app/blog/**` and `app/dashboard/site/template/**` only as needed to understand rendering and the dashboard editor. Do not inspect unrelated blog folders or other repository paths; keep searches path-scoped. Ask the operator if information outside these directories is required.

## Default site and folder-operation shorthand

- Unless the operator indicates another site, the default blog to edit is the dashboard site with handle `local`.
- When the operator asks to “load in the `david` folder,” this means the complete folder-replacement task: resolve the `local` blog ID, copy the contents of `app/templates/folders/david/` into that blog’s live source folder under `data/blogs/blog_<id>/`, replacing the existing contents, then wait for the watcher/rebuild to finish and verify the rendered site. If another blog handle is specified, use that handle instead of `local`.
- When the operator asks to “clear the folder,” remove everything inside the validated live source folder under `data/blogs/blog_<id>/`, including hidden files and nested directories, but leave the source folder itself in place. Use `local` unless another blog handle is specified, then wait for the watcher/rebuild to finish and verify that the live site and Archives reflect the empty source.
- Treat the replacement as exact: include all source-folder contents, including hidden files, and clear only the validated destination folder. Confirm the source and destination paths before removing existing destination contents.

## Edit, fork, and preview

From a worktree, `scripts/development/preview.sh up <url-or-path>` prints a login URL and a direct URL to the work at `https://<slot>-local.blot`; it shows dashboard and blog rendering, and rebuilds template source changes under `app/templates/source` (the shared dev Redis means they also show on `https://local.blot`).

1. Ensure [`https://local.blot/`](https://local.blot/) is reachable. If it is offline, stop and ask the operator to run `npm start`; never substitute another server or URL.
2. If authentication is needed, generate a one-time dashboard link with:

   ```bash
   docker exec blot-node-app-1 node scripts/blog/access.js 'example@example.com'
   ```

   Open the printed URL, then go to [`https://local.blot/sites/local`](https://local.blot/sites/local). Click **Edit template** to open the editor; **Visit site** only views the finished site with its installed template.
3. To edit the source files of a dashboard site, take its handle from the dashboard URL (for example, `local`), then run inside the container:

   ```bash
   docker exec blot-node-app-1 node scripts/info/index.js <handle>
   ```

   `scripts/info/index.js <handle>` returns the ID as `blog_<id>`. Edit the matching host folder under `data/blogs/blog_<id>/`; the Docker path `./data/blogs/...` refers to the same files. Use path-scoped searches such as `rg --files ./data/blogs/blog_<id>` and edit only the requested site files.
4. Edit template definitions under `source/<template>/` (for example, `source/blog/package.json` and `source/blog/style.css`). `package.json` defines `locals`; CSS/HTML consumes them with placeholders such as `{{background_color}}`. These files are separate from the site’s `data/blogs/blog_<id>/` source folder.
5. In the dashboard editor, any `locals` key containing `_color` becomes a color picker. The picker supports a HEXA field plus hue/opacity sliders; **Save** posts the value as `locals.<key>` (for example, `locals.background_color`). Saving a default template first creates a user-owned fork, then writes the changed locals into that fork’s generated `package.json`. **Edit code → package.json** shows the persisted value.
6. This fork-on-write work is intentionally hidden behind a seamless **“just edit the template”** experience: the backend clones the default, switches the site to the user-owned copy when needed, and persists the edit there. **Reset changes** is the supported safe escape hatch for experiments—it discards the fork’s code/settings and restores the original default template. Confirm first: the reset is permanent and cannot be undone.
7. Pair the source with the matching preview: edits under `source/<template>/` affect the main default preview `https://preview-of-<template>-on-local.local.blot/` (for Blog: [`https://preview-of-blog-on-local.local.blot/`](https://preview-of-blog-on-local.local.blot/)), not the separate user fork at `preview-of-my-<template>-on-local.local.blot`. Dashboard edits affect the fork only; they do not update repository source. A URL containing `-my-` is the user-specific fork preview, so remove `-my-` when checking the main default-template preview.
8. After an edit or folder replacement, wait for the template/documentation watcher and blog rebuild to apply the folder change. Use the applicable live site preview as the primary sync check: inspect the homepage, Archives, Search, and relevant permalinks for the expected content. Archives is particularly useful after loading a folder because it confirms which source files were indexed. Preview subdomains and the live blog hot reload once the change is applied, so check the rendered page or output HTML after the rebuild; manually reload only if needed. Do not inspect Docker logs for routine confirmation when the live preview is correct. If content is missing or stale, a rebuild appears stuck, or another sync problem is visible, then use `docker ps` or `docker logs -f --tail 0 blot-node-app-1` to diagnose watcher/rebuild status. Otherwise, inspect the source diff.

## Editing discipline

- Treat CSS order as functional. Before moving rules, preserve specificity and base-before-override relationships.
- For CSS reorganization, use this order where practical: layout, typography, navigation, branding, content, controls, plugins.
- Keep comments concise and customer-facing; explain only non-obvious calculations, conditional rules, or extension boundaries.
- When a task names one template file, inspect and edit only that file unless a dependency is required.
- After source changes, wait for the watcher, then smoke-test the applicable live/default preview homepage plus Archives and Search. Check computed typography and horizontal overflow; use Docker logs only when the preview reveals a sync or rebuild problem.
- Finish with a scoped `git diff --check` and status check; preserve unrelated working-tree changes.
