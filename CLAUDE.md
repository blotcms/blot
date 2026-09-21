# Pull request descriptions

When opening a pull request in this repo:

- Do **not** include a "🤖 Generated with Claude Code" (or similar) footer.
- Do **not** include a "Test plan" section — PRs are covered by CI, so restating a manual test plan is redundant.
- Only include information that isn't already covered by CI or obvious from the diff.
- If the PR requires a manual deployment step beyond a normal deploy — a new environment variable, a one-off migration/script, a manual config change — add a **Deployment plan** section listing exactly what needs to happen and when (e.g. "before deploy: set `BLOT_TOTP_ENCRYPTION_SECRET` in the production environment").
- If the change closes out an item in the root `TODO` file, remove that entry as part of the diff, and if it implies telling someone the work shipped, add that as a checklist item in the PR description.

Commit message trailers (e.g. `Co-Authored-By`) are unrelated to this and should still be included as instructed elsewhere.

# Local preview

`https://local.blot` serves the main checkout, not agent worktrees. To show the operator a worktree's running code, use the `preview` skill (`scripts/development/preview.sh up <url-or-path>`) rather than asking them to check out the branch.
