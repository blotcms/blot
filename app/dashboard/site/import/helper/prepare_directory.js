var fs = require("fs-extra");

module.exports = async function (output_directory) {
  await fs.emptyDir(output_directory);
};
