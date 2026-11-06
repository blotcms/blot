const fs = require("fs-extra");
const archiver = require("archiver");
const config = require("config");
const clfdate = require("helper/clfdate");
const VIEW_DIRECTORY = config.views_directory + "/folders";
const FOLDER_DIRECTORY = __dirname;
const MANIFEST_PATH = VIEW_DIRECTORY + "/manifest.json";

const tmp = require("helper/tempDir")();
const cache = {};

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

// Resolves once the ZIP of one folder is written to tmpPath and copied to
// outputPath, or rejects on an archive error
const archiveFolder = (folder, tmpPath, outputPath) => {
  return new Promise((resolve, reject) => {
    fs.removeSync(tmpPath);

    fs.ensureDirSync(tmp + "folder-zips");

    const output = fs.createWriteStream(tmpPath);

    const archive = archiver("zip", {
      zlib: { level: 9 }, // Sets the compression level.
    });

    output.on("close", function () {
      console.log(archive.pointer() + " total bytes for", folder);
      cache[folder] = tmpPath;
      fs.removeSync(outputPath);
      fs.copy(tmpPath, outputPath).then(resolve, reject);
    });

    // good practice to catch warnings (ie stat failures and other non-blocking errors)
    archive.on("warning", function (err) {
      console.log(err);

      if (err.code === "ENOENT") {
        // log warning
      } else {
        // throw error
        reject(err);
      }
    });

    // good practice to catch this error explicitly
    archive.on("error", function (err) {
      console.log(err);
      reject(err);
    });

    archive.pipe(output);
    archive.directory(FOLDER_DIRECTORY + "/" + folder + "/", false);
    archive.finalize();
  });
};

const main = async () => {
  const folders = fs
    .readdirSync(FOLDER_DIRECTORY)
    .filter((i) => i.indexOf(".") === -1)
    .filter((i) => fs.statSync(FOLDER_DIRECTORY + "/" + i).isDirectory());

  const manifest = {};

  for (const folder of folders) {
    const fullTree = buildFolderTree(FOLDER_DIRECTORY + "/" + folder);
    manifest[folder] = {
      fullTree,
      displayTree: buildDisplayTree(fullTree),
    };

    if (cache[folder]) {
      await fs.copy(cache[folder], VIEW_DIRECTORY + "/" + folder + ".zip");
      continue;
    }

    const tmpPath = tmp + "folder-zips/" + folder + ".zip";

    if (config.environment === "development") {
      if (fs.existsSync(tmpPath)) {
        console.log(
          clfdate(),
          folder,
          "Copying cached ZIP since we are in development environment"
        );
        await fs.copy(tmpPath, VIEW_DIRECTORY + "/" + folder + ".zip");
        continue;
      }
    }

    await archiveFolder(
      folder,
      tmpPath,
      VIEW_DIRECTORY + "/" + folder + ".zip"
    );
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
