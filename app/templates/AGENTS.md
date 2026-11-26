# Working on templates

## Default site and folder-operation shorthand

- Unless the maintainer indicates another site, the default blog to edit is the dashboard site with handle `local`.
- When the maintainer asks to “load in the `david` folder” (check the submodule is checked out first; see Demo folders below), this means the complete folder-replacement task: resolve the `local` blog ID, copy the contents of `app/templates/folders/david/` into that blog’s source directory, `data/local-sources/<handle>/` (the Local client copies it into the blog's folder in the bucket), replacing the existing contents, then wait for the watcher/rebuild to finish and verify the rendered site. If another blog handle is specified, use that handle instead of `local`.
- When the maintainer asks to “clear the folder,” remove everything inside the validated source directory `data/local-sources/<handle>/`, including hidden files and nested directories, but leave the source folder itself in place. Use `local` unless another blog handle is specified, then wait for the watcher/rebuild to finish and verify that the live site and Archives reflect the empty source.
- Treat the replacement as exact: include all source-folder contents, including hidden files, and clear only the validated destination folder. Confirm the source and destination paths before removing existing destination contents.

## Demo folders

- **Where they are:** the demo folders in `app/templates/folders/<name>` are a git submodule, [blotcms/demo-folders](https://github.com/blotcms/demo-folders) (#2940). In a fresh worktree that directory is empty: run `git submodule update --init --depth 1 app/templates/folders`, or let `npm run folder` do it.
- **After a pull:** a pull that moves the pin doesn't update the folders. Run `git submodule update app/templates/folders` (`git status` shows `app/templates/folders` as modified until you do).
- **A checkout from before #2950:** the pull removes the old tracked files but leaves ignored ones, such as `.DS_Store`, and the submodule only checks out into an empty directory. Check with `git status --short --ignored app/templates/folders`, delete what's left if it is only `.DS_Store` files (ask the maintainer about anything else), then run the `--init` command above.
- **A branch from before #2950 that edits folder files:** it conflicts with the move. Make those edits in the submodule instead, with `npm run demo-folders:commit`, and drop them from the branch.
- **Settings and code:** their settings (`config.js`) and the code that builds them live in `app/templates/demo/`. See its README.
- **Committing a folder change:** run `npm run demo-folders:commit -- "<message>"`. It commits and pushes inside the submodule, then commits the new pointer here.
- **Never edit the folders through this repository's index:** `git add app/templates/folders/<file>` doesn't work in a submodule.
- **Publishing:** the deploy syncs changed folders into the production demo blogs and uploads their download ZIPs. Nothing at boot reads the folders, and the image doesn't carry them.

## Sites for checking templates

`npm run folder` builds every site there is for checking a template: one per demo folder in `app/templates/folders` (bees, sergey, david and the rest, each on the template that previews it) and the test sites in `scripts/development/sites`, each meant to break templates in one way:

- `empty`: no posts and no title, for empty states.
- `tiny`: exactly one post.
- `huge`: about 1,500 posts and 300 tags, for pagination, archives and tag pages.
- `torture`: long titles and menu labels, odd image shapes, every file type, a folder post, a draft, a scheduled post and Markdown edge cases.
- `arabic` and `japanese`: right-to-left and CJK writing.

Switch a test site to the template being worked on in the dashboard; re-running `npm run folder` keeps that choice. `npm run folder <handle>` rebuilds one site, and `npm run folder --down` deletes them all. None of it touches the `local` scratchpad site. See `scripts/development/sites/README.md`.

## Edit, fork, and preview

When working from an isolated git worktree, any request to “preview,” “show,” “set up a preview,” or “spin up a preview” must use the maintainer's local `preview` skill (`~/.claude/skills/preview/SKILL.md`): read and follow that file for preview setup, URLs, login links, slot lifecycle, and cleanup. Those instructions take precedence over the main-checkout workflow below. Do not ask for `https://blot.localhost` or use it directly as the worktree preview. You must use host access to access the local server.

## Changing a bundled template

Blogs run their own copies of the bundled templates, so a bundled template in `source/` can be changed, redesigned or replaced without changing anyone's site. Don't flag that as a risk to customers.

How the copy is made: Install only points the blog at `SITE:<name>`. The blog gets its own copy, `{blogID}:<name>`, the first time it changes anything in the template (`app/dashboard/site/template/save/fork-if-needed.js`). A blog still on `SITE:<name>` would see the change, but almost none are: a production count on 15 Nov 2026 found under 0.1% of blogs on any `SITE:` template, and none on the one being replaced. Before reworking a bundled template, recount the blogs on its `SITE:` id if in doubt.

## Editing discipline

- Treat CSS order as functional. Before moving rules, preserve specificity and base-before-override relationships.
- For CSS reorganization, use this order where practical: layout, typography, navigation, branding, content, controls, plugins.
- Keep comments concise and customer-facing; explain only non-obvious calculations, conditional rules, or extension boundaries.
- Highlight.js themes supply the code palette (foreground, background, and token colors); templates own code typography and layout. After the last `{{{syntax_highlighter.styles}}}` insertion, include the shared reset used by the other syntax-highlighting templates. It resets highlighted block display, overflow, spacing, wrapping, and token typography/layout without changing colors or backgrounds. Put template-specific code-block rules after the reset. Do not make `.hljs` backgrounds transparent to defeat the selected theme, and do not edit generated files under `app/blog/static/syntax-highlighter/themes/` for template-specific layout.
- When a task names one template file, inspect and edit only that file unless a dependency is required.
- After source changes, wait for the watcher, then smoke-test the applicable live/default preview homepage plus Archives and Search. Check computed typography and horizontal overflow; use Docker logs only when the preview reveals a sync or rebuild problem.
- Finish with a scoped `git diff --check` and status check; preserve unrelated working-tree changes.

## Responsive navigation in pure CSS

The Album template uses a checkbox and label for its CSS-only menu. The header flex-wraps but clips to one row while closed; the hamburger sits behind an opaque nav background and is revealed when the nav wraps. Checking the box expands the header. Preserve this structure when changing navigation styles.

The background mask depends on alignment: justified nav naturally reaches the hamburger; left-aligned nav grows to fill its row; right-aligned nav reserves the toggle width in the header and offsets the nav background into that space; centered nav uses a trailing `nav::after` background extension so it stays centered and moves with the nav when wrapping. Disable the centered extension while the menu is open so the close icon remains visible. In the expanded menu, hide the spacer; keep links left-aligned, right-aligned, or centered to match the selected alignment.

## Bold selected links without shifting

For horizontal navigation where the selected link becomes bold, reserve the selected-weight label width in every state and overlay the visible label. The Links template tags menu demonstrates this in `links/_toolbar.html` and `links/style.css` (`#tags a strong` and `#tags a span`). The template editor header uses a hidden `::before` label for the same effect.

## Profile photo

`profile_image` is a saved photo plus a `mask` shape name (`square`, `circle`, `rounded-square`, `squircle`, `blob`, `pebble`, `cloud`, `arch`). The shape is baked in when the photo is saved or its shape is changed: `small`, `medium`, `large` and `square` are all transparent outside the shape and cropped to the saved `crop` (`x`, `y`, `width`, `height`, fractions of the original). `profile_image.url` is the whole, uncropped, unmasked photo shrunk to at most 2000px on its longer side, kept so the crop and shape can be edited later, so do not show it in a template. Templates need no CSS for the shape. Do not clip or round the photo yourself (`clip-path`, `border-radius`), and don't add a ring or shadow to it, since those draw around the box rather than the shape. A template that rounds its own avatar should only do so with `{{^profile_image.mask}}`.

Show it with the responsive thumbnail technique below, written out in the template (there is no helper). Inside `{{#profile_image.thumbnails.small}}` the nested sections switch to the medium and large thumbnail, so `url` and `width` are theirs:

```html
{{#profile_image.thumbnails.small}}<img src="{{{url}}}" srcset="{{{url}}} {{width}}w{{#profile_image.thumbnails.medium}}, {{{url}}} {{width}}w{{/profile_image.thumbnails.medium}}{{#profile_image.thumbnails.large}}, {{{url}}} {{width}}w{{/profile_image.thumbnails.large}}" sizes="32px" width="{{width}}" height="{{height}}" alt="">{{/profile_image.thumbnails.small}}
```

Set `sizes` to the photo's rendered CSS width (px, not `em`/`rem`, which follow the browser's default size rather than the template's). The thumbnails are 160, 640 and 1200 pixels wide with nothing in between, so a photo up to about 80 CSS pixels wide gets the 160px file on a 2x screen; wider than that and the browser fetches the 640px one. Keep favicon fallbacks and microformats on `thumbnails.square`. The thumbnails are transparent WebP, so don't use them for social preview metadata.

## Scrollbar room and edge alignment

Keep a page from shifting sideways when a scrollbar appears or disappears (for example when a lightbox locks scrolling) with `html { scrollbar-gutter: stable; }`. Browsers that draw classic scrollbars then reserve that strip on the right at all times, even on a page that never scrolls, so anything aligned to the right edge sits a scrollbar's width further in than the left edge.

To pull a right-aligned control (such as a header nav) back towards the edge, give it a small negative right margin of about a scrollbar's width, roughly `-1em` at the header's type size, with a short comment saying why. This is a deliberate trade: with overlay scrollbars, where no room is reserved, the links sit slightly closer to the edge than the title does on the left.

## Responsive thumbnails

Use `srcset` with width descriptors when a template displays a generated thumbnail at a size that can differ from the available thumbnail sizes. Include the small, medium, and large URLs with their actual pixel widths. Add a `sizes` value that describes the image's rendered CSS width so the browser can choose an appropriate candidate for the viewport and device pixel ratio. Keep a regular `src` as the fallback, and mirror the responsive attributes in a `<noscript>` image when that fallback is present.

The album template uses this pattern in `album/entries.html` and `album/tagged.html`, and the gallery template in `gallery/_card.html` (ruled catalog columns). The portfolio template uses it in `portfolio/fitted-grid.html`, where `sizes` calculates the image width from its aspect ratio and configured row height, and in `portfolio/archives.html` and `portfolio/search.html`, where the thumbnail slot is 80px wide.

Other thumbnail views now use the same pattern: `links/_post.html` and `links/search.html` (responsive grid columns), `studio/entries.html` and `studio/tagged.html` (responsive grid columns), `fieldnotes/related.html` (350px image slot), and `magazine/entry_line.html` (one-third and two-thirds columns). Their existing CSS, image styles, and fallback URLs are preserved; `sizes` describes their current layout so the browser can select among generated variants without changing the rendered dimensions.

Use responsive candidates for displayed thumbnails, not social preview metadata or full-size entry images. When a template has a `<noscript>` image, keep its `srcset` and `sizes` in sync with the primary image.

For images in long index, archive, search, tag, or related-item lists, add `loading="lazy"` so the browser can defer thumbnails outside the viewport. This applies to the repeated thumbnails in the album, portfolio, gallery, links, studio, organization list, and fieldnotes related-items views. Do not lazy-load a hero, featured image, or other image expected to be the page's main above-the-fold image. Keep `loading` on both the primary image and any `<noscript>` fallback. `width` and `height` (or an aspect-ratio wrapper) should still reserve the image's space while it loads. Native `loading` does not apply to CSS background images.

## Contextual navigation

On an entry page, the next/previous arrows and the close button can follow the listing the visitor came from (home grid, archives, a tag, search results, a page of entries) instead of always following chronological order. Portfolio, album and links implement it; copy the block from `portfolio/script.js` (the "Keep the collection an entry was opened from" section) when adding it to another template.

- **Markup contract.** Mark listing entry links `collection-entry` and listing pagination links `collection-previous` / `collection-next`. Mark entry-page links `entry-previous`, `entry-next` and `entry-close`; there may be several of each (links has toolbar and top copies). Keep the real `{{entry.next}}` / `{{entry.previous}}` hrefs in the HTML so the page works without JavaScript.
- **Saving.** Clicking a `collection-entry` link saves the listing's entry order and pagination hrefs to `sessionStorage`. The saved state is ignored unless the visitor arrived from elsewhere on the same site. When `{{cacheID}}` has changed since it was saved (a publish can shift entries between pages), the script refetches the saved listing page and follows its `next` links (then `previous`) a few pages until the entry turns up, then replaces the saved state with that page and carries on as below. If the entry can't be found, the chronological links stay.
- **Upgrading.** On the entry page the script only replaces an arrow's href once the collection neighbour is known. At the edge of a page it fetches the adjacent listing page once and appends it to the saved state. It removes an href only when the collection has genuinely ended, and a failed or uncertain lookup (including a page with no entries) leaves the chronological link alone.
- **Infinite scroll.** Album and links listings are a run of `/page/N` pages (or `/tagged/<slug>/page/N`) loaded so far. The saved state records the first and last page loaded and the script fetches the page after the last or before the first at the edge, treating the collection as ended only once infinite scroll reports its last page. Search is a single unpaginated page of the model's results (capped at 25) and counts as the whole collection, so the arrows stop at its first and last result. Any other listing that isn't paginated that way is unknown at the edge, so the chronological link stays. The infinite scroll footer link must therefore include the tag path on tag pages.
- **Keys.** Handle the left/right keys in `script.js` from the same `entry-*` links so keys and clicks agree. In all three templates left is `entry.next` and right is `entry.previous`, mirroring the index grid (newest first).
- **Closing.** Each entry page knows how many history entries sit between it and the listing (`closeDepth`): one when opened from the listing, one more for every arrow or key step. The depth is handed to the next page through `sessionStorage` (tagged with the target path) and kept in `history.state`, so back, forward and reload agree. `closeEntry()` calls `history.go(-closeDepth)` so the browser restores the listing as it was left, and falls back to the saved listing URL, then `/`, when the depth is unknown (for example an entry opened in a new tab).
