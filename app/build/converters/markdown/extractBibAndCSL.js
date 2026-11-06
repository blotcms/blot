const async = require("async");
const folder = require("storage/folder");
const resolve = require("path").resolve;
const dirname = require("path").dirname;

function getIgnoreCase(obj, key) {
  const lower = key.toLowerCase();
  const k = Object.keys(obj).find((x) => x.toLowerCase() === lower);
  return k ? obj[k] : undefined;
}

module.exports = function (blog, path, metadata, callback) {
  let paths = {
    bib: getIgnoreCase(metadata, "bibliography"),
    csl: getIgnoreCase(metadata, "csl"),
  };

  async.eachOf(
    paths,
    function (pathTo, key, next) {
      paths[key] = "";

      if (!pathTo) return next();

      if (pathTo[0] !== "/") {
        pathTo = resolve(dirname(path), pathTo);
      }

      // pandoc reads both files itself, so it is given real paths
      folder
        .resolveCaseInsensitive(blog.id, pathTo)
        .then((casePath) => folder.ensureLocal(blog.id, casePath))
        .then(
          (local) => {
            paths[key] = local;
            next();
          },
          () => next()
        );
    },
    function (err) {
      callback(null, paths.bib, paths.csl);
    }
  );
};
