# Working on templates

## Default site and folder-operation shorthand

- Unless the operator indicates another site, the default blog to edit is the dashboard site with handle `local`.
- When the operator asks to “load in the `david` folder,” this means the complete folder-replacement task: resolve the `local` blog ID, copy the contents of `app/templates/folders/david/` into that blog’s live source folder under `data/blogs/blog_<id>/`, replacing the existing contents, then wait for the watcher/rebuild to finish and verify the rendered site. If another blog handle is specified, use that handle instead of `local`.
- When the operator asks to “clear the folder,” remove everything inside the validated live source folder under `data/blogs/blog_<id>/`, including hidden files and nested directories, but leave the source folder itself in place. Use `local` unless another blog handle is specified, then wait for the watcher/rebuild to finish and verify that the live site and Archives reflect the empty source.
- Treat the replacement as exact: include all source-folder contents, including hidden files, and clear only the validated destination folder. Confirm the source and destination paths before removing existing destination contents.

## Edit, fork, and preview

When working from an isolated git worktree, any request to “preview,” “show,” “set up a preview,” or “spin up a preview” must use `/Volumes/Blot/blot/.claude/skills/preview/SKILL.md`: read and follow that file for preview setup, URLs, login links, slot lifecycle, and cleanup. Those instructions take precedence over the main-checkout workflow below. Do not ask for `https://local.blot` or use it directly as the worktree preview. You must use host access to access the local server.

## Editing discipline

- Treat CSS order as functional. Before moving rules, preserve specificity and base-before-override relationships.
- For CSS reorganization, use this order where practical: layout, typography, navigation, branding, content, controls, plugins.
- Keep comments concise and customer-facing; explain only non-obvious calculations, conditional rules, or extension boundaries.
- When a task names one template file, inspect and edit only that file unless a dependency is required.
- After source changes, wait for the watcher, then smoke-test the applicable live/default preview homepage plus Archives and Search. Check computed typography and horizontal overflow; use Docker logs only when the preview reveals a sync or rebuild problem.
- Finish with a scoped `git diff --check` and status check; preserve unrelated working-tree changes.
