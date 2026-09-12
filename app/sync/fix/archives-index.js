const client = require("models/client");
const Archives = require("models/archives");

module.exports = function archivesIndex(blog, callback) {
  const entriesKey = "blog:" + blog.id + ":entries";

  Promise.all([client.zCard(entriesKey), Archives.isReady(blog.id)])
    .then(function ([entriesCountResult, ready]) {
      const entriesCount = parseInt(entriesCountResult, 10) || 0;

      if (ready) {
        return archivesEntryCount(blog.id).then(function (archivesCount) {
          if (archivesCount === entriesCount) return callback(null, []);
          return rebuild(entriesCount, archivesCount);
        });
      }

      return rebuild(entriesCount, 0);
    })
    .catch(callback);

  function rebuild(entriesCount, archivesCount) {
    return new Promise(function (resolve, reject) {
      Archives.rebuild(blog.id, function (err, rebuiltCount) {
        if (err) return reject(err);

        resolve(
          callback(null, [
            ["MISMATCH", { entries: entriesCount, archives: archivesCount }],
            ["BACKFILLED", rebuiltCount],
          ])
        );
      });
    });
  }
};

async function archivesEntryCount(blogID) {
  const months = await Archives.months(blogID);

  return months.reduce(function (total, month) {
    return total + month.count;
  }, 0);
}
