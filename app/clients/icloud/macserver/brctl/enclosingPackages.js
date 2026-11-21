// The folders around a path inside a blog's folder (blog_<id>/<name>/...)
// that could be a package, nearest first: those named with an extension, as
// packages are. The blog's folder itself is never one, and an ordinary
// folder is never downloaded whole in a file's place.
const enclosingPackages = (pathInDrive) => {
  const parts = pathInDrive.split("/");
  const packages = [];
  for (let end = parts.length - 1; end >= 3; end--) {
    if (/.\.[^.]+$/.test(parts[end - 1]))
      packages.push(parts.slice(0, end).join("/"));
  }
  return packages;
};

export default enclosingPackages;
