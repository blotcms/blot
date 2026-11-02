# Pull request descriptions

When opening a pull request in this repo:

- Do **not** include a "🤖 Generated with Claude Code" (or similar) footer.
- Do **not** include a "Test plan" section — PRs are covered by CI, so restating a manual test plan is redundant.
- Only include information that isn't already covered by CI or obvious from the diff.
- If the PR requires a manual deployment step beyond a normal deploy — a new environment variable, a one-off migration/script, a manual config change — add a **Deployment plan** section listing exactly what needs to happen and when (e.g. "before deploy: set `BLOT_TOTP_ENCRYPTION_SECRET` in the production environment").
- Any PR with a **Deployment plan** section also gets the `manual-deploy` label (`gh pr create --label manual-deploy`, or `gh pr edit <n> --add-label manual-deploy`), so it stands out as needing more than the `Deploy node` workflow: deploying the proxy, the macserver or the host, running a backfill/migration script, editing production config or environment variables, and so on. Add the label and the section together, and remove both if the extra steps go away.
- If the change closes out an item in the root `TODO` file, remove that entry as part of the diff, and if it implies telling someone the work shipped, add that as a checklist item in the PR description.

Commit message trailers (e.g. `Co-Authored-By`) are unrelated to this and should still be included as instructed elsewhere.

# Pull request review

When you open a pull request in this repo, once you have reviewed it and are happy with it:

- Mark it ready for review, then comment `@codex review` on it.
- Go through up to 3 Codex review cycles, stopping earlier once you are confident the PR is ready to merge.
- Push back on the thread if Codex flags a nitpicky edge case, and raise anything you want the operator's view on during the cycle.
- Never merge a PR without the operator's explicit approval.

# Flaky specs

When a spec fails in CI for a reason unrelated to the change (it passes on a re-run, or fails on a PR that doesn't touch its code), log it in the "Flaky specs" list in the root `TODO` before moving on: the date, the spec file and its name, the error, the PR or branch and commit it failed on, a link to the failed job, and what to investigate. One entry per spec; add later failures to the same entry. Remove the entry when its fix merges.

# Pull request reviews

After opening a pull request in this repo:

- Review it yourself first. Once you're happy with it, mark it ready for review and comment `@codex review`.
- Go through up to 3 Codex review cycles, until you're confident the PR is ready to merge.
- Push back on nitpicky edge cases Codex flags, and discuss anything with the maintainer during the cycle.
- Never merge a PR without the maintainer's explicit approval.

# Squash merges

The maintainer always squash merges. A branch's own commits never reach `master`; only the one squashed commit does. So when PRs depend on each other:

- Stack them: open each later PR against the branch of the one before it (`gh pr create --base <earlier branch>`), not against `master`, so its diff shows only its own change.
- Once the earlier PR is squash merged, rebase the later branch onto `master` with `git rebase --onto origin/master <earlier branch's old tip>`, retarget the PR to `master` (`gh pr edit <n> --base master`) and force push. Merging `master` in instead keeps the earlier PR's commits beside their squashed copy, which conflicts wherever the earlier PR changed after the later one branched off.
- Never rely on a commit from an unmerged branch being in `master` under its own SHA.

# Local preview

`https://local.blot` serves the main checkout, not agent worktrees. To show the operator a worktree's running code, use the `preview` skill (`scripts/development/preview.sh up <url-or-path>`) rather than asking them to check out the branch.

# Redis

Prefer plain commands and `multi()`/`exec()`. Use a Lua script (`client.eval`) only for an atomic compare-then-act that Redis 6.2 can't do natively (no `SET ... IFEQ`/`DELEX` until 8.4), and keep it minimal: a few lines, one decision. Avoid `WATCH` too. The maintainer dislikes both; existing larger Lua scripts are legacy, don't copy them.

# CDN

Bunny does not sit in front of blogs. Blog pages, on subdomains and custom domains, reach the openresty proxy directly, so the proxy sees every visitor's request. Bunny serves only `cdn.blot.im` URLs: static assets, blog CSS and JS, and folder files and generated assets that blog links point there (see `config/storage-bucket/README.md`).
