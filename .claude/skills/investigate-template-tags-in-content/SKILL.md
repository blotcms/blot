---
name: investigate-template-tags-in-content
description: Investigate a customer report that post or page content shows raw {{...}} template tags (or "pages aren't rendering properly") since Blot stopped Mustache-rendering entry content (#1871). Uses a read-only production script to list which posts/pages contain tags and find the owner's email, works out how each file should be fixed, and drafts a short reply email to the customer. Use when a customer says pages/posts that used to render tags like {{entry.metadata.title}} now show them literally.
---

# Investigate template tags in post/page content

## Background

Until #1871 (`a0649297b`, "Stop Mustache-rendering string locals") Blot ran
Mustache over *entry content* as well as templates, so a page containing
`{{entry.metadata.title}}` or `{{#entry.metadata}}…{{/entry.metadata}}` got
the tags expanded. That was never documented. Now entry HTML is data: a
template that outputs `{{{html}}}` prints the tags literally.

What still renders tags:

- Template views and their partials (`{{> head}}`).
- **Entry-path partials**: `{{> /Pages/Weather.md}}` inserts that entry's HTML
  as a *partial*, and partials are still Mustache-rendered against the
  including context (`app/models/template/getPartials.js`). Partial names are
  static (no dynamic partials), so each page needs its own reference.

Custom views have no `entry` in scope, so a separate view cannot read another
page's metadata; the practical fixes are below.

## Find the affected files

**Always confirm with the user before running anything against production,
and stick to read-only commands** (see `investigate-production-container-restarts`
for the host/architecture background: SSH host `blot`, containers
`blot-container-{blue,green,yellow}`).

`scripts/blog/find-template-tags.js` takes a handle, domain or blog ID and
prints the owner's email, then each non-deleted text entry whose *source file*
contains `{{…}}`, with its URL, page/post kind, published state and the
distinct tags (first 10). It does not generate an access token or modify
anything. The script only exists in the image after the PR that added it has
deployed; run it in the **green** container:

```
ssh blot "docker exec blot-container-green node scripts/blog/find-template-tags.js <handle|domain|id>"
```

Add `--json` for machine-readable output. If the script isn't in the deployed
image yet, copy it in temporarily and remove it afterwards:

```
scp scripts/blog/find-template-tags.js blot:/tmp/ftt.js
ssh blot "docker cp /tmp/ftt.js blot-container-green:/usr/src/app/scripts/blog/ftt_tmp.js \
  && docker exec blot-container-green node scripts/blog/ftt_tmp.js <handle|domain|id>; \
  docker exec -u root blot-container-green rm -f /usr/src/app/scripts/blog/ftt_tmp.js; rm -f /tmp/ftt.js"
```

(The container is BusyBox/Alpine: no `ls --time-style`.) The blog folder is at
`/usr/src/app/data/blogs/<blog id>/`, so `cat`/`grep` there is fine for reading
a specific file.

## Classify each file

- **Unpublished** (`unpublished`, or `[draft]` in the name): not visible, ignore.
- **Simple**: only `{{entry.metadata.title}}` / `{{entry.metadata.<key>}}`
  substitutions. Fix: replace the tag with literal text in the file (title in
  the heading, dates and counts as plain values).
- **Data-driven**: `{{#entry.metadata}}…{{/entry.metadata}}` sections or many
  `{{key}}` cells, with the values in front matter. Fix without touching the
  body: in the template's `entry.html`, gate on a front-matter flag and embed
  the entry as a partial instead of `{{{html}}}`:
  ```
  {{#metadata.render_weather}}{{> /Pages/Weather.md}}{{/metadata.render_weather}}
  {{^metadata.render_weather}}{{{html}}}{{/metadata.render_weather}}
  ```
  (inside `{{#entry}}`; needs one gate and one flag per page). Moving markup
  into a template partial instead only works if it is rewritten as HTML,
  because template partials are not run through Markdown.

Check for **generated files**: if front matter changes often or has odd keys
(`fake_last`, hourly values), the customer likely has an external script
writing the files, and hand edits will be overwritten. The generator's
source is the thing that has to change (e.g. add the flag to its output).
Search the folder for scripts (`.py .sh .js .kmmacros`, etc.); it usually
lives on the customer's own machine, so ask them for it.

Verify the approach on a preview or local render before recommending it.

## Reply email

Output a short, apologetic, fluff-free email addressed to the email the script
printed. Cover: what changed (tags in page bodies no longer process; our docs
never said this worked, so it's on us), how many pages are affected and in
which groups, an offer to make the fixes (ask for the generating script if
there is one), the fix in three lines, and an offer of more detail. Do not
send it. Example shape:

> Hi <name>, sorry about that, and thanks for flagging it. Your <page> broke
> because of a recent change: Blot no longer processes `{{…}}` tags written
> inside a page's body. Your pages relied on that; our docs didn't cover it,
> so this is on us. N pages are affected: <simple group>, and <data-driven
> group>. I'm happy to fix them. If a script generates <pages>, could you
> send it? It rewrites them, so it needs to change too. In short: 1) your
> template's `entry.html` gets a small block per page that turns tag
> processing on, 2) the script adds one front-matter line per page to switch
> it on, 3) simple pages get the tags replaced with plain text. Happy to go
> into more detail. Thanks, sorry again.
