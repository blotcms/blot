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

each((user, blog, entry, next) => {
  if (total > 1000) return onComplete();

  if (entry.deleted) return next();

  // 1 in 100 files
  if (Math.floor(Math.random() * 100) > 1) return next();
  const to = join(TMP, entry.id);
  console.log(blog.id, entry.id);
  folder.ensureLocal(blog.id, entry.id).then(function (from) {
    fs.copy(from, to, copied);
  }, copied);

  function copied(err) {
    if (err) {
      console.log(entry);
      console.log(err);
    } else {
      total++;
    }
    next();
  }
}, onComplete);
