const fs = require("fs-extra");
const config = require("config");
const { hashFolder } = require("./contents");
const { keyFor } = require("./publishZip");
const VIEW_DIRECTORY = config.views_directory + "/folders";
const FOLDER_DIRECTORY = __dirname;
const MANIFEST_PATH = VIEW_DIRECTORY + "/manifest.json";

const buildFolderTree = (directoryPath, depth = 0, relativePath = "") => {
  return fs.readdirSync(directoryPath).map((name) => {
    const nodePath = directoryPath + "/" + name;
    const stat = fs.statSync(nodePath);
    const normalizedPath = relativePath ? relativePath + "/" + name : name;

    if (stat.isDirectory()) {
      return {
        name,
        type: "directory",
        children: buildFolderTree(nodePath, depth + 1, normalizedPath),
        depth,
        path: normalizedPath,
      };
    }

    return {
      name,
      type: "file",
      children: [],
      depth,
      path: normalizedPath,
    };
  });
};

const buildDisplayTree = (nodes) => {
  return nodes.map((node) => {
    const displayNode = {
      name: node.name,
      type: node.type,
      depth: node.depth,
      path: node.path,
    };

    if (node.type !== "directory") {
      displayNode.children = [];
      return displayNode;
    }

    if (node.depth > 2) {
      displayNode.collapsed = true;
      displayNode.children = [];
      return displayNode;
    }

    displayNode.children = buildDisplayTree(node.children || []);
    return displayNode;
  });
};

// Writes manifest.json: for each demo folder, its tree (the folder preview on
// its template pages) and the path of its download ZIP on the CDN,
// /folders/<name>-<hash>.zip. The ZIPs themselves aren't built here: the
// deploy uploads them to the storage bucket under the same hash
// (./publishZip, scripts/deploy/demo-folders.js), so the image carries
// neither the folders nor their ZIPs (#2940).
const main = async () => {
  const folders = fs
    .readdirSync(FOLDER_DIRECTORY)
    .filter((i) => i.indexOf(".") === -1)
    .filter((i) => fs.statSync(FOLDER_DIRECTORY + "/" + i).isDirectory());

  const manifest = {};

  for (const folder of folders) {
    const fullTree = buildFolderTree(FOLDER_DIRECTORY + "/" + folder);
    const hash = await hashFolder(FOLDER_DIRECTORY + "/" + folder);
    manifest[folder] = {
      fullTree,
      displayTree: buildDisplayTree(fullTree),
      zip: "/" + keyFor(folder, hash),
    };
  }

  fs.ensureDirSync(VIEW_DIRECTORY);
  fs.writeJsonSync(MANIFEST_PATH, manifest, { spaces: 2 });
};

if (require.main === module) {
  main().then(
    () => process.exit(),
    (err) => {
      throw err;
    }
  );
}

module.exports = main;
module.exports.buildFolderTree = buildFolderTree;
module.exports.buildDisplayTree = buildDisplayTree;
