var fs = require("fs-extra");
var join = require("path").join;

module.exports = function walk(dir) {
  var results = [];
  fs.readdirSync(dir).forEach(function (file) {
    file = join(dir, file);
    var stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      results.push(file);
    }
  });
  return results;
};
