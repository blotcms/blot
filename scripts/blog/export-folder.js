// Writes a blog's folder to stdout as a tar archive, read through
// storage/folder, so it can be copied off a host:
//
//   ssh blot "docker exec blot-blue node /usr/src/app/scripts/blog/export-folder <blog ID>" | tar -x -C <dir>
//
// Used by `npm run download-folder` and `npm run fork`. Nothing else may be
// printed to stdout; progress and errors go to stderr.

const archiver = require("archiver");
const folder = require("storage/folder");

async function main(blogID) {
  const archive = archiver("tar");
  let files = 0;

  archive.on("warning", (err) => console.error(err));
  archive.pipe(process.stdout);

  const done = new Promise((resolve, reject) => {
    archive.on("error", reject);
    process.stdout.on("finish", resolve);
  });

  for await (const path of folder.walk(blogID, "/", { directories: true })) {
    const stat = await folder.stat(blogID, path);
    const name = path.slice(1);
    const date = new Date(stat.modified);

    if (stat.isDirectory) {
      archive.append(null, { name: name + "/", type: "directory", date });
      continue;
    }

    // Streamed one file at a time: the next starts only once archiver has
    // taken this one, so stdout's backpressure bounds what is held in memory
    const source = folder.createReadStream(blogID, path);
    await new Promise((resolve, reject) => {
      const fail = (err) => {
        archive.off("entry", taken);
        reject(err);
      };
      const taken = () => {
        source.off("error", fail);
        resolve();
      };
      archive.once("entry", taken);
      source.once("error", fail);
      archive.append(source, { name, date });
    });
    files++;
  }

  await archive.finalize();
  await done;

  console.error("Exported", files, "files of", blogID);
}

if (!process.argv[2]) {
  console.error("Pass a blog ID as the first argument");
  process.exit(1);
}

main(process.argv[2]).then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
