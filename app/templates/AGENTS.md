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
- Highlight.js themes supply the code palette (foreground, background, and token colors); templates own code typography and layout. After the last `{{{syntax_highlighter.styles}}}` insertion, include the shared reset used by the other syntax-highlighting templates. It resets highlighted block display, overflow, spacing, wrapping, and token typography/layout without changing colors or backgrounds. Put template-specific code-block rules after the reset. Do not make `.hljs` backgrounds transparent to defeat the selected theme, and do not edit generated files under `app/blog/static/syntax-highlighter/themes/` for template-specific layout.
- When a task names one template file, inspect and edit only that file unless a dependency is required.
- After source changes, wait for the watcher, then smoke-test the applicable live/default preview homepage plus Archives and Search. Check computed typography and horizontal overflow; use Docker logs only when the preview reveals a sync or rebuild problem.
- Finish with a scoped `git diff --check` and status check; preserve unrelated working-tree changes.

## Responsive navigation in pure CSS

The Album template uses a checkbox and label for its CSS-only menu. The header flex-wraps but clips to one row while closed; the hamburger sits behind an opaque nav background and is revealed when the nav wraps. Checking the box expands the header. Preserve this structure when changing navigation styles.

The background mask depends on alignment: justified nav naturally reaches the hamburger; left-aligned nav grows to fill its row; right-aligned nav reserves the toggle width in the header and offsets the nav background into that space; centered nav uses a trailing `nav::after` background extension so it stays centered and moves with the nav when wrapping. Disable the centered extension while the menu is open so the close icon remains visible. In the expanded menu, hide the spacer; keep links left-aligned, right-aligned, or centered to match the selected alignment.

## Profile photo

`profile_image` is a saved photo plus a `mask` shape name (`square`, `circle`, `rounded-square`, `squircle`, `hexagon`, `arch`). The shape is baked in when the photo is saved or its shape is changed: `small`, `medium`, `large` and `square` are all transparent outside the shape, and the original is left whole. Templates need no CSS for the shape. Do not clip or round the photo yourself (`clip-path`, `border-radius`), and don't add a ring or shadow to it, since those draw around the box rather than the shape. A template that rounds its own avatar should only do so with `{{^profile_image.mask}}`.

Show it with the responsive thumbnail technique below, written out in the template (there is no helper). Inside `{{#profile_image.thumbnails.small}}` the nested sections switch to the medium and large thumbnail, so `url` and `width` are theirs:

```html
{{#profile_image.thumbnails.small}}<img src="{{{url}}}" srcset="{{{url}}} {{width}}w{{#profile_image.thumbnails.medium}}, {{{url}}} {{width}}w{{/profile_image.thumbnails.medium}}{{#profile_image.thumbnails.large}}, {{{url}}} {{width}}w{{/profile_image.thumbnails.large}}" sizes="32px" width="{{width}}" height="{{height}}" alt="">{{/profile_image.thumbnails.small}}
```

Set `sizes` to the photo's rendered CSS width (px, not `em`/`rem`, which follow the browser's default size rather than the template's). The thumbnails are 160, 640 and 1200 pixels wide with nothing in between, so a photo up to about 80 CSS pixels wide gets the 160px file on a 2x screen; wider than that and the browser fetches the 640px one. Keep favicon fallbacks and microformats on `thumbnails.square`. The thumbnails are transparent WebP, so don't use them for social preview metadata.

## Responsive thumbnails

Use `srcset` with width descriptors when a template displays a generated thumbnail at a size that can differ from the available thumbnail sizes. Include the small, medium, and large URLs with their actual pixel widths. Add a `sizes` value that describes the image's rendered CSS width so the browser can choose an appropriate candidate for the viewport and device pixel ratio. Keep a regular `src` as the fallback, and mirror the responsive attributes in a `<noscript>` image when that fallback is present.

The album template uses this pattern in `album/entries.html` and `album/tagged.html`. The portfolio template uses it in `portfolio/fitted-grid.html`, where `sizes` calculates the image width from its aspect ratio and configured row height, and in `portfolio/archives.html` and `portfolio/search.html`, where the thumbnail slot is 80px wide.

Other thumbnail views now use the same pattern: `gallery/_item.html` (`thumbnail_size` square), `links/_post.html` and `links/search.html` (responsive grid columns), `studio/entries.html` and `studio/tagged.html` (responsive grid columns), `fieldnotes/related.html` (350px image slot), and `magazine/entry_line.html` (one-third and two-thirds columns). Their existing CSS, image styles, and fallback URLs are preserved; `sizes` describes their current layout so the browser can select among generated variants without changing the rendered dimensions.

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
