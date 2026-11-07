const Sync = require("sync");
const { promisify } = require("util");

module.exports = function (blogID) {
  return new Promise((resolve, reject) => {
    Sync(blogID, function check(err, folder, done) {
      if (err) return reject(err);
      // folder.update already returns a promise
      // I don't quite understand this
      const doneAsync = async function (err) {
        if (err) {
          await promisify(done.bind(null, err))();
        } else {
          await promisify(done.bind(null, null))();
        }
      };
      resolve({ folder, done: doneAsync });
    });
  });
};
