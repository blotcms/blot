# Test sites

Local development sites for working on templates, beside the demo folder sites in `app/templates/folders`. Unlike those, they never reach production.

| Site | What it's for |
| --- | --- |
| `empty` | No posts, no files, no title: empty states |
| `tiny` | Exactly one post |
| `huge` | About 1,500 posts over 15 years, about 300 tags: pagination, archives, tags |
| `torture` | Long titles and menu labels, odd image shapes, every file type, folder posts, drafts, edge cases in Markdown |
| `arabic` | Right-to-left writing |
| `japanese` | Japanese writing |

```sh
npm run folder            # build every demo folder site and every test site
npm run folder torture    # build one test site
npm run folder --down     # delete them all; the local site is left alone
npm run folder list       # list the folders and sites
```

Each site is a module here exporting `{ settings, build }`. `build(dir)` writes the site's files into its Local client source directory, `data/local-sources/{handle}`. Only files that changed are rewritten, so a re-run is cheap. A new blog gets the module's template and an existing one keeps whatever template it was switched to, while the title and menu are reset on every run.

Most of the material comes from the demo folders, through `material.js`. Pick it by scanning (`texts()`, `images()`, `converterSamples()`) and copy it with `copy()`, which skips a missing file with a warning, so cleaning up the demo folders never breaks a site. The Arabic and Japanese writing is committed here, since there is none in the demo folders.

A site with many files takes a while to appear in full after its first build, while the Local client syncs it: `huge` takes about half an hour.
