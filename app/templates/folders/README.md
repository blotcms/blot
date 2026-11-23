# Folders

Demo folders: the material each bundled template is previewed on. A template names its folder with the `demo_folder` local in its `package.json`, and `config.js` here sets each folder blog's title, template, menu and plugins.

In production every folder here becomes a public demo blog and a ZIP people can download from the templates pages, so put test material that only makes sense in development in `scripts/development/sites` instead (see its README).

## Local development

With the server running (`npm start`):

```sh
npm run folder              # build every demo folder blog, then the test sites
npm run folder marmalade    # build one folder, rebuilding as you edit it
npm run folder --down       # delete the demo folder blogs and test sites
```

Once a folder's blog exists, the Local client keeps it in step with the folder in the checkout, and edits to `config.js` apply as you save.

## Add a new folder

Create `app/templates/folders/marmalade`, add its settings to `config.js`, then run `npm run folder marmalade`. Set `"demo_folder": "marmalade"` in a template's locals to preview that template on it.

## Publish new folders

Merge to master and deploy. The deploy's last step, `scripts/deploy/demo-folders.js` (#2940), sends each folder that changed since the last deploy to the host and syncs it into its demo blog from inside a unit (`index.js --from <dir> --only <name> --zip`). It also uploads the folder's ZIP to the storage bucket as `folders/<name>-<hash>.zip`, where `<hash>` is `contents.js`'s hash of the folder's files. `app/cdn` serves it at `/folders/<name>-<hash>.zip`. Each folder's ZIP from before the change is kept, and older ones are deleted. The image doesn't carry the folders, and the docs build links each ZIP through `manifest.json`. In development, the download link only works once a folder's ZIP is in the local bucket. Run `node app/templates/folders/index.js <name> --zip` to put it there. The host keeps a marker, `~/demo-folders.json`, holding each folder's git tree hash from its last sync. To sync again by hand, run `npm run deploy-demo-folders` from master.
