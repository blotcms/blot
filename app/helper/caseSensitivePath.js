var fs = require("fs");
var Path = require("path");

// Picks which entry of a directory listing a name refers to: the exact name
// if present, otherwise the first entry (in listing order) which matches
// ignoring case. Shared so callers which already hold a listing choose the
// same entry caseSensitivePath would.
function pick(contents, name) {
  var folded = name.normalize().toLowerCase();
  var similar;

  for (var i = 0; i < contents.length; i++) {
    if (contents[i] === name) return name;
    if (
      similar === undefined &&
      contents[i].normalize().toLowerCase() === folded
    )
      similar = contents[i];
  }

  return similar;
}

function caseSensitivePath(cwd, path, callback) {
  // Will do many things, importantly it will
  // replace double slashes, e.g. /a/b//c -> /a/b/c
  path = Path.normalize(path);
  cwd = Path.normalize(cwd);

  // We must remove a leading slash if it exists
  // otherwise splitting it by the slash will change
  // the results. '/a/b'.split('/') is ['', 'a', 'b']
  // while 'a/b'.split('/') is ['a', 'b']
  while (path[0] === "/") path = path.slice(1);
  while (path.slice(-1) === "/") path = path.slice(0, -1);

  // We must remove a trailing slash from the current
  // working directory to ensure paths mesh nicely
  while (cwd.slice(-1) === "/") cwd = cwd.slice(0, -1);

  var dirs = path.split("/");
  var name = dirs.shift();

  fs.readdir(cwd, function guess(err, contents) {
    if (err) return callback(err);
    var match = pick(contents, name);

    if (match === undefined) {
      err = new Error("No path matches: " + path);
      err.code = "ENOENT";
      return callback(err);
    }

    cwd += "/" + match;

    if (dirs.length) {
      name = dirs.shift();
      fs.readdir(cwd, guess);
    } else {
      callback(null, cwd);
    }
  });
}

module.exports = caseSensitivePath;
module.exports.pick = pick;
