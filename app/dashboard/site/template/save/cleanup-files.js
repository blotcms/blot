const fs = require("fs-extra");

// Multiparty writes uploaded files to a temporary directory before our routes
// run. Removing them is the application's responsibility, on every exit path.
const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
};

module.exports = async function cleanupFiles(files = {}) {
  const removals = [];

  for (const key of Object.keys(files)) {
    for (const file of toArray(files[key])) {
      if (file && file.path) {
        removals.push(fs.remove(file.path).catch(() => {}));
      }
    }
  }

  await Promise.all(removals);
};
