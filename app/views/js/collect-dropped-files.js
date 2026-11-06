// Turns a drag-and-drop payload or a file input's selection into a flat list
// of { file, relativePath } records, keeping the path of each file inside the
// folder that was dropped.
//
// The same traversal is inlined in the folder browser
// (views/dashboard/folder/directory.html). This module is the shared version;
// the folder browser can adopt it separately.

// readEntries returns a partial batch and must be called until it returns an
// empty one. Reading it once is the classic way to lose files in a big folder.
function readAllDirectoryEntries(directoryReader) {
  return new Promise(function (resolve, reject) {
    var entries = [];

    function readBatch() {
      directoryReader.readEntries(function (batch) {
        if (!batch.length) return resolve(entries);
        entries = entries.concat(Array.from(batch));
        readBatch();
      }, reject);
    }

    readBatch();
  });
}

function collectDroppedFilesFromEntry(entry, parentPath) {
  var basePath = parentPath || "";

  if (entry.isFile) {
    return new Promise(function (resolve, reject) {
      entry.file(function (file) {
        resolve([
          {
            file: file,
            relativePath: (basePath + file.name).replace(/^\//, ""),
          },
        ]);
      }, reject);
    });
  }

  if (entry.isDirectory) {
    var nextParent = (basePath + entry.name + "/").replace(/^\//, "");
    var reader = entry.createReader();

    return readAllDirectoryEntries(reader).then(function (entries) {
      return Promise.all(
        entries.map(function (childEntry) {
          return collectDroppedFilesFromEntry(childEntry, nextParent);
        })
      ).then(function (nested) {
        return nested.reduce(function (all, set) {
          return all.concat(set);
        }, []);
      });
    });
  }

  return Promise.resolve([]);
}

// webkitGetAsEntry is the only way to read a dropped directory, and it is
// vendor prefixed. Where it is missing we fall back to whatever the browser
// gave us: a directory <input> still supplies webkitRelativePath.
function collectDroppedFiles(dataTransfer) {
  var items = Array.from((dataTransfer && dataTransfer.items) || []);
  var files = Array.from((dataTransfer && dataTransfer.files) || []);

  if (!items.length) {
    return Promise.resolve(
      files.map(function (file) {
        return {
          file: file,
          relativePath: file.webkitRelativePath || file.name,
        };
      })
    );
  }

  var hasEntrySupport = items.some(function (item) {
    return (
      item.kind === "file" &&
      typeof item.webkitGetAsEntry === "function" &&
      item.webkitGetAsEntry()
    );
  });

  if (!hasEntrySupport) {
    return Promise.resolve(
      files.map(function (file) {
        return {
          file: file,
          relativePath: file.webkitRelativePath || file.name,
        };
      })
    );
  }

  // Entry support is per item, not per payload: one item can yield a directory
  // entry while another yields none. Falling back for the whole payload only
  // when every item lacks an entry would silently drop those odd ones out, so
  // fall back for each item on its own.
  var tasks = items.map(function (item, index) {
    if (item.kind !== "file") return Promise.resolve([]);

    var entry =
      typeof item.webkitGetAsEntry === "function"
        ? item.webkitGetAsEntry()
        : null;

    if (entry) return collectDroppedFilesFromEntry(entry, "");

    var file =
      typeof item.getAsFile === "function" ? item.getAsFile() : files[index];

    if (!file) return Promise.resolve([]);

    return Promise.resolve([
      { file: file, relativePath: file.webkitRelativePath || file.name },
    ]);
  });

  return Promise.all(tasks).then(function (sets) {
    return sets.reduce(function (all, set) {
      return all.concat(set);
    }, []);
  });
}

// Dragging text or a link should not put the page into its drop state
function hasFileDragPayload(dataTransfer) {
  if (!dataTransfer) return false;

  var items = Array.from(dataTransfer.items || []);
  if (
    items.some(function (item) {
      return item.kind === "file";
    })
  ) {
    return true;
  }

  var types = Array.from(dataTransfer.types || []);
  if (
    types.some(function (type) {
      return String(type).toLowerCase() === "files";
    })
  ) {
    return true;
  }

  return Array.from(dataTransfer.files || []).length > 0;
}

function collectSelectedFiles(input) {
  return Array.from((input && input.files) || []).map(function (file) {
    return { file: file, relativePath: file.webkitRelativePath || file.name };
  });
}

module.exports = {
  readAllDirectoryEntries: readAllDirectoryEntries,
  collectDroppedFilesFromEntry: collectDroppedFilesFromEntry,
  collectDroppedFiles: collectDroppedFiles,
  collectSelectedFiles: collectSelectedFiles,
  hasFileDragPayload: hasFileDragPayload,
};
