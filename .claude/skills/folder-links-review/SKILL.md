---
name: folder-links-review
description: Review what Blot's request-time folder-link rewrite (app/blog/render/replaceFolderLinks) still does in production, from the [folder-links] and [folder-asset-origin] log lines, to decide what has to move to entry build time or template save time before the runtime pass can be deleted. Pulls the app container logs over ssh, aggregates them with scripts/folder-links/analyze-logs.js, maps each finding to the next piece of migration work, and appends a short entry to this skill's findings log. Use when asked to review folder links, check progress on removing replaceFolderLinks, or re-run the folder-link log analysis.
---

# Folder-link rewrite review

## Background

`app/blog/render/middleware.js` runs `replaceFolderLinks/html.js` (HTML
views) and `replaceFolderLinks/css.js` (CSS views) over every rendered page,
rewriting links to files in the blog's folder into versioned CDN URLs with a
disk lookup (`lookupFile.js`). The goal is to delete that pass and do the
work earlier instead:

- **Entries:** already baked at build time by
  `app/build/plugins/folderAssets` (#1896), with `%%BLOT_CDN%%` tokens.
- **Templates:** to be baked when a view is saved (`Template.setView`).

The pass is instrumented ([#2032](https://github.com/blotcms/blot/pull/2032))
so production traffic tells us what it still rewrites. Two `req.log` lines:

```
[folder-links] blog=<id> handle=<h> template=<id> view=<name> kind=html|css rewrites=N enoent=N ms=N sources=template:2,entry:1 forms=root:2,relative:1 sample=ok:template:root:/a.jpg,enoent:entry:relative:b.jpg
[folder-asset-origin] blog=<id> handle=<h> path=<path> referer_path=<path>
```

- `[folder-links]`: one per request where the pass rewrote a link or found
  no file for one. Format documented in `replaceFolderLinks/stats.js`.
- `[folder-asset-origin]`: a blog-folder file (not an HTML page) served by
  the app with a Referer from one of the blog's own pages, i.e. a link that
  reached the origin instead of the CDN. Logged by `app/blog/routes/assets.js`.

Field meanings:

- `source`: where the original link text was found.
  - `template`: the view or partial source.
  - `entry`: `entry.html` of an entry on the page.
  - `metadata`: an entry's metadata.
  - `other`: none of those, e.g. menu URLs, template locals, or links
    assembled from variables like `{{blog.url}}/x.jpg`.
  - Partials pulled in from the folder (`{{> /file.html}}`) count as
    `template`.
- `form`:
  - `root`: starts with `/`.
  - `relative`: no leading slash. These break if the pass is removed,
    because browsers resolve them against the page URL.
  - `host`: an absolute URL on one of the blog's own hosts.
  - `static`: a reserved global path (`/fonts`, `/katex`…).

Removing the pass is safe for `root`, `host` and `static` links in the sense
that `app/blog/routes/assets.js` still serves them from the origin. The page
only loses CDN caching for those files. `relative` links are the
correctness risk.

## 1. Check the instrumentation is live

The log lines only exist once #2032 is deployed. Check the PR is merged
(`gh pr view 2032 --repo blotcms/blot --json state,mergedAt`).

**Always confirm with the user before running anything against production**,
even read-only commands, and stick to read-only commands. The SSH host is
`blot`.

```bash
ssh blot "docker ps --format '{{.Names}}\t{{.Status}}'"
```

Container logs only go back to the last deploy or restart. That uptime
bounds the window: use it as `--since`, and note it in the report.

## 2. Collect and aggregate

Pull the logs once into the scratchpad, filtered to the two markers, and
analyse locally. The script is plain Node with no dependencies and reads
stdin, so it doesn't need to run on the host. `$SCRATCH` is your
scratchpad directory, or any local temp directory.

```bash
for c in blue green yellow; do
  ssh blot "docker logs --since 24h blot-container-$c 2>&1 | grep -F -e '[folder-links]' -e '[folder-asset-origin]'"
done > "$SCRATCH/folder-links.log"

node scripts/folder-links/analyze-logs.js --top 20 < "$SCRATCH/folder-links.log"
node scripts/folder-links/analyze-logs.js --json < "$SCRATCH/folder-links.log" > "$SCRATCH/folder-links.json"
```

For the share of all HTML/CSS requests that hit the pass, compare against
the `Replacing folder links with CDN links` lines. Every non-preview HTML or
CSS render logs one:

```bash
for c in blue green yellow; do
  ssh blot "docker logs --since 24h blot-container-$c 2>&1 | grep -cF 'Replacing folder links with CDN links'"
done
```

## 3. Interpret

Map each bucket from the source × form table (built from sampled links) and
the per-line totals onto the migration work.

| Finding | What it means | Work it points to |
|---|---|---|
| `template` + `root`/`host` | Literal folder links in a view or partial | Bake at template save time in `Template.setView`, with template→file dependencies so file changes re-bake the view and regenerate the `{{#cdn}}` manifest |
| `template` + `relative` | Template links without a leading slash; **would break** if the pass were removed | Same as above, resolving relative to the view; list affected templates explicitly |
| `entry` (any form) | Entry HTML not baked: built before #1896, or a missing-file dependency never fired | Build-version stamp plus a throttled rebuild of unstamped entries; check the dependency gaps below |
| `entry` with `enoent` | Entry links to a file that doesn't exist | Expected for genuinely broken links. If the file *does* exist under a different case or encoding, it's the dependents-key gap (case-sensitive keys, percent-encoded `poster`/`srcset` paths) |
| `metadata` | `{{metadata.image}}` and friends in attributes (og:image etc.) | Decide whether to bake eligible metadata path values at entry build time |
| `other` | Menu URLs, template locals, variable-assembled links | Bake menu/locals at save time; for assembled host links, find the template pattern |
| `static` | `/fonts`, `/katex`… in entries or templates | Bake reserved static paths at build/save time (global file if present, else blog file) |
| High `enoent` with low `rewrites` | Pass doing disk lookups for nothing | Pure cost; note which blogs/templates |
| `ms` | Time the pass adds, including lookups | The performance case for removal |
| `[folder-asset-origin]` | Pages still sending browsers to the origin for folder files | Fetch the public `referer_path` page (`curl -s https://<host><referer_path>`) and find the link that wasn't rewritten. These continue after removal |

To drill into one blog or template, grep the raw lines in the scratch file.
It's local, so no further prod access is needed:

```bash
grep -F 'handle=<handle> ' "$SCRATCH/folder-links.log" | head
grep -F 'template=<templateID> ' "$SCRATCH/folder-links.log" | awk '{for(i=1;i<=NF;i++) if ($i ~ /^sample=/) print $i}' | sort | uniq -c | sort -rn | head
```

For an `entry` finding, confirm by fetching the public page and checking
whether the rewritten link sits inside the post body. If the entry's file was
last modified before #1896 shipped, it was simply never rebuilt.

## 4. Report

In chat (blog handles, templates and paths are fine there), give:

- the window and containers;
- the share of HTML/CSS renders that produced a `[folder-links]` line;
- the source × form breakdown;
- the top blogs and templates per bucket, with a sample link each;
- `relative` cases, called out separately;
- the `[folder-asset-origin]` summary;
- which migration work each bucket points to, ranked by share of rewrites.

Then append an entry to the findings log below. Delete the scratch files when
done.

## Findings log

Read this first: earlier runs show the trend and which work has already
landed. Newest entries last.

**Privacy: this file is committed to the repo, so entries must contain no
customer information.** Leave out blog IDs, handles, domains, template IDs,
file names and paths. Describe things generically ("a handful of custom
templates link `/favicon.ico` literally"). Also leave out absolute request,
blog or line counts, because they reveal userbase scale. Use percentages
and shares only.

Entry template:

```
### <date> — <window, e.g. 24h across blue/green/yellow>
- Pass hit: <share of HTML/CSS renders with a [folder-links] line>
- Rewrites by source: template x%, entry y%, metadata z%, other w%
- Forms: root …, relative …, host …, static …
- Notable: <generic description of the biggest buckets and any relative cases>
- [folder-asset-origin]: <generic summary>
- Since last run: <what migration work landed, how the shares moved>
- Next: <the work the biggest bucket points to>
```
