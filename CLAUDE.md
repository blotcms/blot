# Pull request descriptions

When opening a pull request in this repo:

- Do **not** include a "🤖 Generated with Claude Code" (or similar) footer.
- Do **not** include a "Test plan" section — PRs are covered by CI, so restating a manual test plan is redundant.
- Only include information that isn't already covered by CI or obvious from the diff.
- If the PR requires a manual deployment step beyond a normal deploy — a new environment variable, a one-off migration/script, a manual config change — add a **Deployment plan** section listing exactly what needs to happen and when (e.g. "before deploy: set `BLOT_TOTP_ENCRYPTION_SECRET` in the production environment").
- Any PR with a **Deployment plan** section also gets the `manual-deploy` label (`gh pr create --label manual-deploy`, or `gh pr edit <n> --add-label manual-deploy`), so it stands out as needing more than the `Deploy node` workflow: deploying the proxy, the macserver or the host, running a backfill/migration script, editing production config or environment variables, and so on. Add the label and the section together, and remove both if the extra steps go away.
- If the change closes out an item in the root `TODO` file, remove that entry as part of the diff, and if it implies telling someone the work shipped, add that as a checklist item in the PR description.

Commit message trailers (e.g. `Co-Authored-By`) are unrelated to this and should still be included as instructed elsewhere.

# Local preview

`https://local.blot` serves the main checkout, not agent worktrees. To show the operator a worktree's running code, use the `preview` skill (`scripts/development/preview.sh up <url-or-path>`) rather than asking them to check out the branch.

# Redis

Prefer plain commands and `multi()`/`exec()`. Use a Lua script (`client.eval`) only for an atomic compare-then-act that Redis 6.2 can't do natively (no `SET ... IFEQ`/`DELEX` until 8.4), and keep it minimal: a few lines, one decision. Avoid `WATCH` too. The maintainer dislikes both; existing larger Lua scripts are legacy, don't copy them.

# CDN

Bunny does not sit in front of blogs. Blog pages, on subdomains and custom domains, reach the openresty proxy directly, so the proxy sees every visitor's request. Bunny serves only `cdn.blot.im` URLs: static assets, blog CSS and JS, and folder files and generated assets that blog links point there (see `config/storage-bucket/README.md`).
