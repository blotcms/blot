const each = require("../each/entry");
const folder = require("storage/folder");
const TMP = require("helper/tempDir")() + "/thousand";
const fs = require("fs-extra");
const join = require("path").join;

let total = 0;

const onComplete = (err) => {
  if (err) throw err;
  console.log("done! wrote result to", TMP);
  process.exit();
};

async function copyRandomEntry(user, blog, entry) {
  if (total > 1000) return onComplete();

  if (entry.deleted) return;

  // 1 in 100 files
  if (Math.floor(Math.random() * 100) > 1) return;
  const to = join(TMP, entry.id);
  console.log(blog.id, entry.id);

  try {
    const from = await folder.ensureLocal(blog.id, entry.id);
    await fs.copy(from, to);
    total++;
  } catch (err) {
    console.log(entry);
    console.log(err);
  }
}

each.promise(copyRandomEntry).then(
  () => onComplete(),
  (err) => onComplete(err)
);
