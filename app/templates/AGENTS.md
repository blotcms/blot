# Working on templates

## Scope

- Edit only `app/templates/**`.
- Read `app/blog/**` and `app/dashboard/site/template/**` only as needed to understand rendering and the dashboard editor. Do not inspect or modify other repository paths; keep searches path-scoped. Ask the operator if information outside these directories is required.

## Edit, fork, and preview

1. Ensure [`https://local.blot/`](https://local.blot/) is reachable. If it is offline, stop and ask the operator to run `npm start`; never substitute another server or URL.
2. If authentication is needed, generate a one-time dashboard link with:

   ```bash
   docker exec blot-node-app-1 node scripts/blog/access.js 'example@example.com'
   ```

   Open the printed URL, then go to [`https://local.blot/sites/local`](https://local.blot/sites/local). Click **Edit template** to open the editor; **Visit site** only views the finished site with its installed template.
3. Edit the repository source under `source/<template>/` (for example, `source/blog/package.json` and `source/blog/style.css`). `package.json` defines `locals`; CSS/HTML consumes them with placeholders such as `{{background_color}}`.
4. In the dashboard editor, any `locals` key containing `_color` becomes a color picker. The picker supports a HEXA field plus hue/opacity sliders; **Save** posts the value as `locals.<key>` (for example, `locals.background_color`). Saving a default template first creates a user-owned fork, then writes the changed locals into that fork’s generated `package.json`. **Edit code → package.json** shows the persisted value.
5. This fork-on-write work is intentionally hidden behind a seamless **“just edit the template”** experience: the backend clones the default, switches the site to the user-owned copy when needed, and persists the edit there. **Reset changes** is the supported safe escape hatch for experiments—it discards the fork’s code/settings and restores the original default template. Confirm first: the reset is permanent and cannot be undone.
6. Pair the source with the matching preview: edits under `source/<template>/` affect the main default preview `https://preview-of-<template>-on-local.local.blot/` (for Blog: [`https://preview-of-blog-on-local.local.blot/`](https://preview-of-blog-on-local.local.blot/)), not the separate user fork at `preview-of-my-<template>-on-local.local.blot`. Dashboard edits affect the fork only; they do not update repository source. A URL containing `-my-` is the user-specific fork preview, so remove `-my-` when checking the main default-template preview.
7. After an edit, wait for the template/documentation watcher to rebuild, then reload the preview for a rendered check. Otherwise, inspect the source diff. If useful, run `docker ps` or follow logs with `docker logs -f --tail 0 blot-node-app-1`.
