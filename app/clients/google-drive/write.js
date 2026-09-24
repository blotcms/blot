const createDriveClient = require("./serviceAccount/createDriveClient");
const dirname = require("path").dirname;
const basename = require("path").basename;
const computeMd5Checksum = require("./util/md5Checksum");
const localPath = require("helper/localPath");
const clfdate = require("helper/clfdate");
const fs = require("fs-extra");
const TMP = require("helper/tempDir")();
const guid = require("helper/guid");
const { Readable } = require("stream");
const database = require("./database");
const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

// We can make this much more efficient by thoughtfully using
// streams in pipelines rather than wastefully
// We don't need to update the client database
// of file IDs because once removed, we'll sync
// with google drive after receiving a webhook
module.exports = async function write(blogID, path, input, callback) {
  const prefix = () => clfdate() + " Google Drive:";

  try {
    if (path[0] !== "/") path = "/" + path;

    if (shouldIgnoreFile(path)) {
      return callback(new Error(`Cannot write ignored file: ${path}`));
    }

    console.log(prefix(), "writing input to tmp");
    const tempPath = await writeToTmp(input);

    const pathOnBlot = localPath(blogID, path);

    console.log(prefix(), "calculating md5Checksum for", tempPath);
    const md5Checksum = await computeMd5Checksum(tempPath);
    console.log(prefix(), " md5Checksum for", tempPath, "is", md5Checksum);

    console.log(prefix(), "calculating md5Checksum for", pathOnBlot);
    const md5ChecksumOnBlot = await computeMd5Checksum(pathOnBlot);
    console.log(
      prefix(),
      " md5Checksum for",
      pathOnBlot,
      "is",
      md5ChecksumOnBlot
    );

    if (md5ChecksumOnBlot === md5Checksum) {
      console.log(
        prefix(),
        "md5Checksum matches so no need to make any changes"
      );
      await fs.remove(tempPath);
      return callback(null);
    }

    const account = await database.blog.get(blogID);
    const drive = await createDriveClient(account.serviceAccountId);

    if (account.folderId) {
      console.log(prefix(), "will save remote file");

      const { getByPath } = database.folder(account.folderId);

      const fileId = await getByPath(path);

      if (fileId) {
        console.log(prefix(), "will update existing file");

        await drive.files.update({
          fileId: fileId,
          supportsAllDrives: true,
          media: {
            body: fs.createReadStream(tempPath),
          },
        });
      } else {
        console.log(prefix(), "will create new remote file");

        const pathParent = dirname(path);

        const parentID =
          (await getByPath(pathParent)) ||
          (await establishParentDirectories(
            drive,
            pathParent,
            account.folderId
          ));

        await drive.files.create({
          resource: {
            name: basename(path),
            parents: [parentID],
          },
          supportsAllDrives: true,
          media: {
            body: fs.createReadStream(tempPath),
          },
          fields: "id",
        });
      }
    }

    console.log(prefix(), "moving", tempPath, "to", pathOnBlot);
    await fs.move(tempPath, pathOnBlot, { overwrite: true });
  } catch (e) {
    return callback(e);
  }
  callback(null);
};

// Turns a buffer or string into a readable stream
const makeStream = (input) => {
  const readableInstanceStream = new Readable({
    read() {
      this.push(input);
      this.push(null);
    },
  });

  return readableInstanceStream;
};

const writeToTmp = (input) => {
  return new Promise((resolve, reject) => {
    let readStream;

    if (input instanceof Readable) {
      readStream = input;
    } else if (Buffer.isBuffer(input) || typeof input === "string") {
      readStream = makeStream(input);
    }

    const tempPath = TMP + "/" + guid();
    const writeStream = fs.createWriteStream(tempPath);
    writeStream.on("error", reject).on("close", () => resolve(tempPath));
    readStream.pipe(writeStream);
  });
};

const establishParentDirectories = async (drive, pathParent, blogFolderID) => {
  if (pathParent === "/") return blogFolderID;

  const parentDirs = pathParent.split("/").slice(1);

  const walk = async (folderId, parentDirs) => {
    const dirToCheck = parentDirs.shift();

    const { data } = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    let dirID =
      data.files.filter((i) => i.name === dirToCheck).length &&
      data.files.filter((i) => i.name === dirToCheck)[0].id;

    if (!dirID) {
      const res = await drive.files.create({
        resource: {
          name: dirToCheck,
          parents: [folderId],
          mimeType: "application/vnd.google-apps.folder",
        },
        supportsAllDrives: true,
        fields: "id",
      });

      dirID = res.data.id;
    }

    return parentDirs.length ? walk(dirID, parentDirs) : dirID;
  };

  return await walk(blogFolderID, parentDirs);
};
