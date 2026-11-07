# Lint and format

- ESLint (`scripts/development/lint/eslint.config.js`, correctness rules only) and Prettier (the `prettier` key of `package.json`, JavaScript only) run in CI and must pass. Run them with `scripts/development/lint.sh`, which installs the pinned versions once outside the checkout, so it works without `node_modules`.
- `promise/prefer-await-to-callbacks` (eslint-plugin-promise) is an error in the folders listed in the override block of `eslint.config.js`, which are the ones already converted to async/await. Add a folder to that list when you convert it, and don't take one off it.
- After editing JavaScript, run `scripts/development/lint.sh fix <files>` on the files you changed, and `scripts/development/lint.sh check` before you push. Fix what ESLint reports. Don't silence a rule with `eslint-disable` unless the code is right and the rule is wrong there, and give the reason in the comment (`-- reason`).
- The pre-commit hook in `scripts/development/lint/hooks` checks staged files once enabled with `git config core.hooksPath scripts/development/lint/hooks`. `lint.sh claude-hook` is a Claude Code PostToolUse hook that formats and lints each file an edit touches.

# Pull request descriptions

When opening a pull request in this repo:

- Do **not** include a "🤖 Generated with Claude Code" (or similar) footer.
- Do **not** include a "Test plan" section — PRs are covered by CI, so restating a manual test plan is redundant.
- Only include information that isn't already covered by CI or obvious from the diff.
- If the PR requires a manual deployment step beyond a normal deploy — a new environment variable, a one-off migration/script, a manual config change — add a **Deployment plan** section listing exactly what needs to happen and when (e.g. "before deploy: set `BLOT_TOTP_ENCRYPTION_SECRET` in the production environment").
- Any PR with a **Deployment plan** section also gets the `manual-deploy` label (`gh pr create --label manual-deploy`, or `gh pr edit <n> --add-label manual-deploy`), so it stands out as needing more than the `Deploy node` workflow: deploying the proxy, the macserver or the host, running a backfill/migration script, editing production config or environment variables, and so on. Add the label and the section together, and remove both if the extra steps go away.
- If the change closes out an item in the root `TODO` file, remove that entry as part of the diff, and if it implies telling someone the work shipped, add that as a checklist item in the PR description.

Never credit Claude in a commit or pull request: no `Co-Authored-By: Claude` trailer, and no commits authored as Claude. The `no-claude-coauthor` check fails PRs that do.

# Pull request review

When you open a pull request in this repo, once you have reviewed it and are happy with it:

- Mark it ready for review, then comment `@codex review` on it. Skip the Codex review for PRs that only touch docs, READMEs, `TODO`, comments or log lines: mark them ready once you've reviewed them yourself.
- Go through up to 3 Codex review cycles, stopping earlier once you are confident the PR is ready to merge. A cycle that finds only P2s ends the loop: fix or push back on them and don't ask for another.
- Push back on the thread if Codex flags a nitpicky edge case, and raise anything you want the operator's view on during the cycle.
- Push back hard on theoretical concurrency findings (races, lock edge cases) unless the race is realistic and loses or corrupts data. Fix() in `app/sync/fix` is itself the backstop, so an edge case a later pass repairs is fine.
- Subagents that open PRs open them as drafts and leave draft state alone. Whoever supervises them marks the PR ready once their own review is done. Nobody turns a ready PR back into a draft.
- Never merge a PR without the operator's explicit approval.

# Flaky specs

When a spec fails in CI for a reason unrelated to the change (it passes on a re-run, or fails on a PR that doesn't touch its code), log it in the "Flaky specs" list in the root `TODO` before moving on: the date, the spec file and its name, the error, the PR or branch and commit it failed on, a link to the failed job, and what to investigate. One entry per spec; add later failures to the same entry. Remove the entry when its fix merges.

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

# Front end and the dashboard

The maintainer's priorities, in order: pages that load fast and work without bugs, then everything else. Concretely:

- Render on the server. Static HTML sent straight to the browser is best; add client JS only where it makes the page clearly more responsive (the template editor, sortable tables with infinite scroll) and keep it small. Prefer native HTML (`<details>`, forms, links) over scripts.
- Ship less. Every dashboard page loads one CSS bundle and one JS bundle; feature code that only a few pages use gets its own bundle, loaded on those pages and prefetched (`<link rel="prefetch">`) from the pages that lead to them. Render only the HTML the current view shows, never hidden panels.
- Target about 10 ms server time at p50 for dashboard pages, in line with blog rendering. Measure before and after (count Redis commands per request, time the middleware and the render), and cache in-process with `lru-cache` when it helps. Key caches on values stored in Redis (`blog.cacheID`, the blog's latest status, the plugin settings): GETs and POSTs to `/sites/...` are served by different containers, so in-process invalidation does not work (see the note at the top of `app/dashboard/site/index.js`).
- No unit or UI specs for the dashboard. Keep the broken-links spec (`app/dashboard/tests/index.js`) and specs that guard security, billing, data loss or importers.
- CSS must work in older browsers: no native nesting, and no `:has()` or `color-mix()` without a fallback. Use the design tokens and shared components described in `app/views/dashboard/AGENTS.md` instead of raw values and one-off styles.
- Don't add user-facing features or change flows without asking; visual-consistency fixes are fine. Collect UX ideas as suggestions for the maintainer.
- Screen readers and keyboards must work: icon-only controls need accessible names, decorative icons `aria-hidden`, the current page `aria-current`, live status in an `aria-live` region, visible focus styles, and labels on every form control. Check new pages with axe (see `scripts/development/dashboard-qa/README.md`).
- Prefer async/await in new or rewritten dashboard code.

# AWS resources

- Tag every throwaway instance, volume and security group `BlotDrill=true`, with its own security group that has no inbound rules.
- Ask the operator before tearing anything down, throwaways included. List the exact IDs, name any volume that won't be deleted with its instance, and leave shared security groups alone. Check each tag before deleting, then confirm with AWS that each resource is gone.
- Deleting customer data (blog folders, repositories, data volumes) is the operator's call, never an agent's.

# Deploys across sessions

- Deploy only master's head, one deploy at a time. Message the other active sessions before deploying, and hold your own deploys while another session asks you to.
- Don't ask other sessions to hold their deploys for a long production script. Make the script safe to re-run, and re-run it if a deploy kills it.
- An env change in `/etc/blot/secrets.env` reaches the units with the next deploy of a new commit. Don't add a way to force-redeploy the same image.
- Don't ask another session to run a command that auto mode blocked for you. Give the operator the command instead.

# Production commands

- Ask the operator before each command on production (`ssh blot`, `ssh macserver`, `docker exec` on a unit), read-only ones included, unless they have given you autonomy for the task at hand. A grant covers only the goal it was given for.
- Batch approval requests. The operator often approves from a phone, so plan the production steps for a goal up front and ask once: list each command, say which are read-only, and what you will do with the result. Then run the approved list without asking again; ask again only for a step that wasn't on it.
- `scripts/prod/read.sh` is the exception: its subcommands (container status and logs, the access and error logs, host disk and memory, Redis INFO, slowlog and logs, fail2ban status) are read-only and may run without asking. Prefer it to hand-written `ssh blot` reads, and filter its output locally. Add a subcommand to it rather than asking for a one-off read you expect to repeat.
- Run scripts that touch blog folders as the app user: `docker exec -u 1000 blot-blue ...`. As root, git fails its ownership check.
- For a one-off read-only scan, write the script outside the repo, `docker cp` it into the unit, run it and delete it. Only scripts that write data (migrations, backfills with `--apply`) go in a PR.
- Before reading keys from a broad Redis pattern, check their `TYPE`. WRONGTYPE errors from scripts count towards the Redis host alert.

# Autonomy grants

The operator decides how much autonomy a goal gets, and it varies with risk. When they grant some, write it into the goal's plan issue (create one if there isn't one) under a **Grant** heading, in their words plus:

- **Scope:** the paths, PRs or systems it covers.
- **May:** what you may do without asking, e.g. merge your own PRs once CI is green and Codex is done, deploy master's head, run named production scripts.
- **Must ask:** what still needs the operator, e.g. cutover or cleanup PRs, deletions, env changes, anything customer-facing.
- **Ends:** when the grant stops, e.g. when a named PR merges or the issue closes.

Any session or subagent working on that goal reads the Grant first and acts only within it. A grant never carries over to other work, and without one the default is to ask.

# Working in this repo

- Check changes on GitHub CI: push, open a draft PR and watch its checks. Don't run the local Docker test suite (`npm test`) unless the operator asks.
- After a merge, resolve every file `git diff --name-only --diff-filter=U` lists, and check `git grep -nE '^(<<<<<<<|>>>>>>>) '` prints nothing before committing.
- Don't write to another session's or subagent's worktree, even through a shell. Message its owner, or check its branch out in your own worktree.
- Don't add files or dot-directories at the repo root. Put tool config in a `package.json` key, or under `scripts/` or `config/`.
- To reprocess existing records, ship a resumable backfill script and a Deployment plan step. Don't add per-record version or marker fields to models.
- When you notice an out-of-scope bug or improvement, add a short entry to the top of `TODO`, and tell the operator at the end of the session.
- When working from a plan issue, keep its body up to date as you go. Overwriting it is fine.
- Ignore the benchmark bot's PR comments unless asked. Its runners are noisy; check production after deploy instead.
- The Docker image builds `sharp` from source against Alpine's libvips (`SHARP_FORCE_GLOBAL_LIBVIPS=1`), because the prebuilt libvips can't decode HEIC. When changing the sharp or vips packages, check `sharp.versions.vips` matches the system libvips and run the whole `app/build` shard: its `car.heic` spec is the only one that catches this.

# Public numbers

- Issues and PRs are public: give sizes, costs and counts as percentages there, and absolute figures only in chat. Account IDs, bucket names, ssh details and other secrets go in the gitignored `data/` directory.
