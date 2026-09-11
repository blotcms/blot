const multiparty = require("multiparty");
const fs = require("fs-extra");

// Request-owned uploads are removed even when later middleware rejects the
// request. Background jobs explicitly take ownership before sending a response.
module.exports = function multipart(options = {}) {
  const formOptions = {
    maxFilesSize: 30 * 1024 * 1024,
    ...options,
    uploadDir: options.uploadDir || require("helper/tempDir")(),
  };

  return function parse(req, res, next) {
    if (!req.is("multipart/form-data")) return next();

    const files = new Set();
    const retained = new Set();
    let finished = false;
    const remove = async (path) => {
      try {
        await fs.remove(path);
        files.delete(path);
      } catch (err) {
        console.error("Failed to remove temporary upload", err);
      }
    };
    const cleanup = () => {
      finished = true;
      return Promise.all([...files].filter(path => !retained.has(path)).map(remove));
    };

    req.retainUpload = (file) => {
      if (finished || !file || !files.has(file.path)) {
        throw new Error("Cannot retain an upload not owned by this request");
      }
      const path = file.path;
      retained.add(path);
      return async () => {
        retained.delete(path);
        await remove(path);
      };
    };

    res.once("finish", cleanup);
    res.once("close", cleanup);

    const form = new multiparty.Form(formOptions);
    form.on("file", (_name, file) => {
      files.add(file.path);
      if (finished) remove(file.path);
    });
    form.parse(req, (err, fields, uploads) => {
      if (err) {
        cleanup(); // multiparty also removes partially written files on error
        if (err.code === "ETOOBIG") err.status = 413;
        if (!res.destroyed && !res.writableEnded) next(err);
        return;
      }
      if (finished) return;

      req.body = Object.fromEntries(Object.keys(fields).map(key => [
        key, fields[key].length === 1 ? fields[key][0] : fields[key],
      ]));
      req.files = uploads;
      // Preserve other upload fields; cleanup retains the complete file list.
      if (uploads.avatar) req.files.avatar = uploads.avatar[0];
      next();
    });
  };
};
