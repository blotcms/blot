require("templates");
const clfdate = require("helper/clfdate");

module.exports = function () {
  beforeAll(async function () {
    console.log(clfdate(), "[tests] Building global templates");
    await require("templates")({ watch: false });
    console.log(clfdate(), "[tests] Built global templates");
  }, 15 * 1000);
};
