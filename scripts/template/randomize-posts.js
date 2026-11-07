// will randomize all the dates associated with each blog post
// useful for testing template designs

var get = require("../get/blog");
var moment = require("moment");
var Entries = require("models/entries");
var Entry = require("models/entry");

var identifier = process.argv[2];
var limit = process.argv[3];
var end = moment();

if (limit) {
  limit = moment(new Date(limit));
} else {
  limit = moment().subtract(2, "years");
}

console.log("Randomizing dates for all entries without date metadata...");
console.log("Start date: " + limit.format());
console.log("End date: " + end.format());

function getBlog(identifier) {
  return new Promise(function (resolve, reject) {
    get(identifier, function (err, user, blog) {
      if (err) return reject(err);
      resolve(blog);
    });
  });
}

function eachEntry(blogID, doThis) {
  return new Promise(function (resolve, reject) {
    Entries.each(
      blogID,
      function (entry, next) {
        doThis(entry).then(
          function () {
            next();
          },
          function (err) {
            next(err);
          }
        );
      },
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

async function setEntry(blogID, path, updates) {
  await Entry.set(blogID, path, updates);
}

async function main() {
  var blog = await getBlog(identifier);

  await eachEntry(blog.id, async function (entry) {
    if (entry.deleted || entry.draft || entry.scheduled || entry.page) return;

    // if (entry.metadata.date) return next();

    var newDateStamp =
      limit.valueOf() +
      Math.floor(Math.random() * (end.valueOf() - limit.valueOf()));

    // console.log(newDateStamp, moment(newDateStamp).format(), entry.path);

    await setEntry(blog.id, entry.path, { dateStamp: newDateStamp });
  });

  console.log("Complete!");
  process.exit();
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
