const fs = require("fs");
const { join } = require("path");

function list(dir) {
  const files = fs.readdirSync(dir);
  return files.reduce((acc, file) => {
    const path = join(dir, file);
    const isDirectory = fs.statSync(path).isDirectory();
    return isDirectory ? [...acc, ...list(path)] : [...acc, path];
  }, []);
}

module.exports = list;
