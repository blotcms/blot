const fs = require("fs-extra");
const { join } = require("path");

const database = require("clients/google-drive/database");
const localReaddir = require("clients/google-drive/sync/util/localReaddir");
const truncateToSecond = require("clients/google-drive/sync/util/truncateToSecond");

const main = async function (blogID) {
  await check(blogID);
};

const check = async (blogID) => {
  const account = await database.blog.get(blogID);
  const { get, readdir } = database.folder(account.folderId);

  const databaseReaddir = async (readdir, dir) => {
    const contents = await readdir(dir);
    return contents.map(({ path, metadata, id }) => ({
      name: path.split("/").pop(),
      id,
      ...metadata,
    }));
  };

  const walk = async (dir) => {
    console.log("checking", dir);

    const [localContents, databaseContents] = await Promise.all([
      localReaddir(blogID, dir),
      databaseReaddir(readdir, dir),
    ]);


    for (const file of databaseContents) {
      if (!localContents.find((item) => item.name === file.name)) {
        console.log(
          "path=",
          join(dir, file.name),
          "present in database but not found locally"
        );
      }
    }

    for (const { name, isDirectory } of localContents) {
      const itemInDatabase = databaseContents.find(
        (item) => item.name === name
      );
      if (!itemInDatabase) {
        console.log("path=", join(dir, name), "not found in database");
      } 

      if (isDirectory) {
        await walk(join(dir, name));
      }
    }
  };

  try {
    await walk("/", account.folderId);
  } catch (err) {
    console.log(err);
  }
};

if (require.main === module) {
  const get = require("../get/blog");

  get(process.argv[2], async function (err, user, blog) {
    if (err) throw err;

    console.log("Checking local files against database for blog", blog.id);
    await main(blog.id);
    console.log("Done");

    process.exit();
  });
}
