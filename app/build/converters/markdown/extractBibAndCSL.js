const folder = require("storage/folder");
const withResults = require("build/withResults");
const resolve = require("path").resolve;
const dirname = require("path").dirname;

function getIgnoreCase(obj, key) {
  const lower = key.toLowerCase();
  const k = Object.keys(obj).find((x) => x.toLowerCase() === lower);
  return k ? obj[k] : undefined;
}

async function extractBibAndCSL(blog, path, metadata) {
  let paths = {
    bib: getIgnoreCase(metadata, "bibliography"),
    csl: getIgnoreCase(metadata, "csl"),
  };

  await Promise.all(
    Object.keys(paths).map(async function (key) {
      let pathTo = paths[key];

      paths[key] = "";

      if (!pathTo) return;

      if (pathTo[0] !== "/") {
        pathTo = resolve(dirname(path), pathTo);
      }

      // pandoc reads both files itself, so it is given real paths
      try {
        const casePath = await folder.resolveCaseInsensitive(blog.id, pathTo);
        paths[key] = await folder.ensureLocal(blog.id, casePath);
      } catch (err) {}
    })
  );

  return [paths.bib, paths.csl];
}

// Called back with (err, bib, csl); without a callback it resolves to
// [bib, csl]
module.exports = withResults(extractBibAndCSL);
