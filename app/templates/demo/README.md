# Demo folders

Demo folders are the material each bundled template is previewed on. In production, every folder becomes a public demo blog (`<name>.blot.im`) and a ZIP people can download from the templates pages. So put test material that only makes sense in development in `scripts/development/sites` instead (see its README).

- **The folders:** they live in `app/templates/folders/<name>`. That directory is a git submodule, the [blotcms/demo-folders](https://github.com/blotcms/demo-folders) repository. It keeps them out of this repository's history, its CI checkouts and its image (#2940).
- **Settings:** this directory holds `config.js`, which sets each demo blog's title, template, menu and plugins.
- **Code:** this directory also holds the code that builds the demo blogs (`index.js`, `setupBlogs.js`, `setupUser.js`, `local.js`) and the code for the ZIPs (`contents.js`, `publishZip.js`, `zip.js`).
- **Choosing a folder:** a template names its folder with the `demo_folder` local in its `package.json`.

## Check out the folders

A fresh clone or worktree has an empty `app/templates/folders`, because a submodule isn't checked out by default. `npm run folder` checks it out the first time. To do it by hand:

```sh
git submodule update --init app/templates/folders
```

After you pull a commit that moves the pin, run the same command again to update the folders.

## Local development

With the server running (`npm start`):

```sh
npm run folder              # build every demo folder blog, then the test sites
npm run folder marmalade    # build one folder, rebuilding as you edit it
npm run folder --down       # delete the demo folder blogs and test sites
```

Once a folder's blog exists, the Local client keeps it in step with the folder in the checkout. Edits to `config.js` apply as you save.

## Change a folder, or add one

1. Edit the files in `app/templates/folders/<name>`, or create `app/templates/folders/marmalade` for a new folder. For a new folder, also add its settings to `config.js` here.
2. To preview, run `npm run folder marmalade`. Set `"demo_folder": "marmalade"` in a template's locals to preview that template on it.
3. Commit in both places with `npm run demo-folders:commit -- "Add the marmalade folder"`.
   - It commits the change inside the submodule and pushes it to blotcms/demo-folders' master.
   - It then commits the new submodule pointer in this repository. Push that, or open a PR with it, as usual.
   - A change to `config.js` alone is an ordinary commit in this repository.

A PR that moves the pin runs the Screenshots workflow for the templates previewed on the folders that changed.

## Publish

Merge to master and deploy. Before it replaces the units, the deploy runs `scripts/deploy/demo-folders.js` (#2940):

1. **Changed folders:** it fetches the demo-folders commit that master pins, without blobs. It compares each folder's tree hash, and the hash of its `config.js` settings, with a marker on the host (`~/demo-folders.json`). Only the folders that changed go on.
2. **Sync:** it sends those folders and this commit's `config.js` to the host. It syncs each one into its demo blog from inside the running unit, with `index.js --from <dir> --only <name> --zip`.
3. **ZIP:** it uploads each folder's ZIP to the storage bucket as `folders/<name>-<hash>.zip`, where `<hash>` is `contents.js`'s hash of the folder's files. `app/cdn` serves it at `cdn.blot.im/folders/<name>-<hash>.zip`. The docs build links each ZIP through `manifest.json`. Each folder's previous ZIP is kept for a rollback, and older ones are deleted.

To sync again by hand, run `npm run deploy-demo-folders` from master.

In development, a template page's download link only works once that folder's ZIP is in the local bucket. Run `node app/templates/demo/index.js <name> --zip` to put it there.
