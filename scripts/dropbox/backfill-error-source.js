const clfdate = require("helper/clfdate");
const { promisify } = require("util");
const Blog = require("models/blog");
const database = require("clients/dropbox/database");
const { backfillPatch } = require("clients/dropbox/util/classifyError");

const getAllIDs = promisify(Blog.getAllIDs);
const getBlog = promisify(Blog.get);
const getAccount = promisify(database.get);
const setAccount = promisify(database.set);

const DRY_RUN = process.argv.indexOf("--write") === -1;

async function main() {
  const blogIDs = await getAllIDs();
  let checked = 0;
  let patched = 0;

  for (const blogID of blogIDs) {
    const blog = await getBlog({ id: blogID });
    if (!blog || blog.client !== "dropbox") continue;

    const account = await getAccount(blogID);
    if (!account) continue;

    checked += 1;
    const patch = backfillPatch(account);
    if (!patch) continue;

    patched += 1;
    console.log(
      clfdate(),
      blogID,
      "error_code=" + account.error_code,
      "error_source=" + (account.error_source || ""),
      "→",
      JSON.stringify(patch)
    );

    if (!DRY_RUN) {
      await setAccount(blogID, patch);
    }
  }

  console.log(
    clfdate(),
    "Dropbox error-source backfill",
    DRY_RUN ? "(dry run)" : "(written)",
    "checked=" + checked,
    "patched=" + patched
  );

  if (DRY_RUN && patched) {
    console.log(
      clfdate(),
      "Re-run with --write to apply these changes."
    );
  }
}

main()
  .then(function () {
    process.exit(0);
  })
  .catch(function (err) {
    console.error(err);
    process.exit(1);
  });
