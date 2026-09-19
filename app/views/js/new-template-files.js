var collect = require("./collect-dropped-files.js");

// Drag-and-drop upload on the 'New template' page. Ships in dashboard.min.js,
// which every dashboard page loads, so do nothing unless the panel is present.

// Keep these in step with save/constants.js. Checking here means the common
// mistake — dropping a whole site, or a folder full of images — gets a clear
// message instead of the generic 413 page the multipart limit would produce.
var MAX_RAW_FILES = 1000;
var MAX_TOTAL_BYTES = 10 * 1024 * 1024;

var ZIP_PATTERN = /\.zip$/i;
var ZIP_TYPES = ["application/zip", "application/x-zip-compressed"];

function isZip(file) {
  return ZIP_PATTERN.test(file.name) || ZIP_TYPES.indexOf(file.type) > -1;
}

function totalBytes(entries) {
  return entries.reduce(function (total, entry) {
    return total + (entry.file.size || 0);
  }, 0);
}

function init(root) {
  var dropzone = root.querySelector("[data-template-upload-dropzone]");
  var folderInput = root.querySelector("[data-template-upload-folder-input]");
  var zipInput = root.querySelector("[data-template-upload-zip-input]");

  var empty = root.querySelector("[data-template-upload-empty]");
  var selected = root.querySelector("[data-template-upload-selected]");
  var selectedLabel = root.querySelector("[data-template-upload-selected-label]");
  var fileList = root.querySelector("[data-template-upload-files]");
  var clear = root.querySelector("[data-template-upload-clear]");

  var errorBox = root.querySelector("[data-template-upload-error]");
  var errorMessage = root.querySelector("[data-template-upload-message]");
  var problemList = root.querySelector("[data-template-upload-problems]");
  var dismiss = root.querySelector("[data-template-upload-dismiss]");

  var csrfToken = root.getAttribute("data-csrf");
  var action = root.getAttribute("data-action");

  if (!dropzone || !action) return;

  var dragDepth = 0;
  var working = false;

  // One row per file, keyed by path so the response can update them in place
  var rows = {};

  function setLabel(text) {
    if (selectedLabel) selectedLabel.textContent = text || "";
  }

  function setStatus(message) {
    setLabel(message);
  }

  function showEmptyState() {
    rows = {};
    if (fileList) fileList.innerHTML = "";
    if (empty) empty.hidden = false;
    if (selected) selected.hidden = true;
  }

  // Replaces the drop instructions with one row per file, the way the
  // importer swaps its instructions for the file it is about to import
  function showFiles(paths, label) {
    if (!fileList || !selected) return;

    rows = {};
    fileList.innerHTML = "";

    paths.forEach(function (path) {
      var row = document.createElement("div");
      row.className = "file-drop__chip template-upload__file";

      var name = document.createElement("span");
      name.className = "file-drop__name";
      name.textContent = path;

      var state = document.createElement("span");
      state.className = "template-upload__file-state";

      // A dim dot while queued, a pulsing one while uploading and the
      // sync status tick once done
      var indicator = document.createElement("span");
      indicator.className = "template-upload__file-indicator";
      indicator.setAttribute("aria-hidden", "true");

      var tick = document.createElement("span");
      tick.className = "icon-small-check";
      indicator.appendChild(tick);

      row.appendChild(indicator);
      row.appendChild(name);
      row.appendChild(state);
      fileList.appendChild(row);

      rows[path] = { row: row, state: state };
    });

    setLabel(label);

    if (empty) empty.hidden = true;
    selected.hidden = false;
  }

  function setFileState(path, text, modifier) {
    var entry = rows[path];
    if (!entry) return;

    // Finished files drop to the bottom, so the active file and the queue
    // stay at the top of a long list
    if (modifier === "done" && !/--done/.test(entry.row.className)) {
      fileList.appendChild(entry.row);
    }

    entry.state.textContent = text || "";
    entry.row.className =
      "file-drop__chip template-upload__file" +
      (modifier ? " template-upload__file--" + modifier : "");
  }

  function renderList(list, items, withPath) {
    if (!list) return;

    list.innerHTML = "";

    (items || []).forEach(function (item) {
      var li = document.createElement("li");
      var path = withPath && item.path;

      if (path) {
        var code = document.createElement("code");
        code.textContent = path;
        li.appendChild(code);
        li.appendChild(document.createTextNode(" "));
      }

      li.appendChild(
        document.createTextNode(
          (withPath ? item.message : item) || "This file could not be used"
        )
      );

      list.appendChild(li);
    });
  }

  function hideNotices() {
    if (errorBox) errorBox.hidden = true;
  }

  function showError(message, problems) {
    setStatus("");

    if (!errorBox) return;

    if (errorMessage) errorMessage.textContent = message || "";
    renderList(problemList, problems, true);
    errorBox.hidden = false;
  }

  function setWorking(isWorking) {
    working = isWorking;
    root.classList.toggle("is-working", isWorking);
    if (folderInput) folderInput.disabled = isWorking;
    if (zipInput) zipInput.disabled = isWorking;
  }

  function buildFormData(entries) {
    var formData = new FormData();

    if (entries.length === 1 && isZip(entries[0].file)) {
      formData.append("zip", entries[0].file, entries[0].file.name);
    } else {
      var relativePaths = [];

      entries.forEach(function (entry, index) {
        var field = "upload-" + index;
        formData.append(field, entry.file, entry.file.name);
        relativePaths.push({
          field: field,
          index: 0,
          relativePath: entry.relativePath,
        });
      });

      formData.append("relativePaths", JSON.stringify(relativePaths));
    }

    formData.append("_csrf", csrfToken);

    return formData;
  }

  // The server stores any warnings with the success message, so the new
  // template's page can show them above the template itself
  function finish(result) {
    window.location = result.redirect;
  }

  // The files travel in one request, in order, so the bytes sent so far say
  // which files have gone. Each is marked done once its share has been sent
  // and the next one pulses, as the importer does for its own steps.
  function send(entries, paths) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var sizes = entries.map(function (entry) {
        return entry.file.size || 0;
      });
      var fileBytes = sizes.reduce(function (a, b) {
        return a + b;
      }, 0);
      var done = 0;

      function markProgress(fraction) {
        var sent = fraction * fileBytes;
        var end = 0;
        var active = -1;

        for (var i = 0; i < paths.length; i++) {
          end += sizes[i];

          if (i < done) continue;

          if (sent >= end && fraction > 0) {
            setFileState(paths[i], "", "done");
            done = i + 1;
          } else {
            active = i;
            break;
          }
        }

        if (active > -1) setFileState(paths[active], "", "working");
      }

      markProgress(0);

      xhr.upload.onprogress = function (event) {
        if (event.lengthComputable && event.total) {
          markProgress(Math.min(event.loaded / event.total, 0.999999));
        }
      };

      xhr.upload.onload = function () {
        markProgress(1);
        paths.forEach(function (path) {
          setFileState(path, "", "done");
        });
        setLabel("Creating template…");
      };

      xhr.onerror = function () {
        reject(new Error("Something went wrong uploading this template."));
      };

      xhr.onload = function () {
        var result;

        try {
          result = JSON.parse(xhr.responseText);
        } catch (e) {
          // The multipart limit is enforced before our route runs and
          // renders an HTML error page rather than JSON
          return reject(
            new Error(
              xhr.status === 413
                ? "Those files are too large to upload."
                : "Something went wrong uploading this template."
            )
          );
        }

        if (xhr.status < 200 || xhr.status >= 300) {
          var error = new Error(
            result.error || "This template could not be uploaded."
          );
          error.problems = result.problems;
          return reject(error);
        }

        resolve(result);
      };

      xhr.open("POST", action);
      xhr.send(buildFormData(entries));
    });
  }

  function upload(entries) {
    if (working) return;

    hideNotices();

    // Dropping an empty folder collects nothing. Saying so beats the page
    // appearing not to have noticed the drop at all.
    if (!entries.length) {
      return showError(
        "There are no files in that folder to make a template from.",
        []
      );
    }

    if (entries.length > MAX_RAW_FILES) {
      return showError(
        "That folder contains " +
          entries.length +
          " files, which is far more than a template can use.",
        []
      );
    }

    if (totalBytes(entries) > MAX_TOTAL_BYTES) {
      return showError(
        "Those files are too large to be a template. The most a template can be is " +
          Math.round(MAX_TOTAL_BYTES / 1024 / 1024) +
          " MB.",
        []
      );
    }

    setWorking(true);

    var paths = entries.map(function (entry) {
      return entry.relativePath;
    });

    showFiles(
      paths,
      paths.length === 1
        ? "Uploading 1 file…"
        : "Uploading " + paths.length + " files…"
    );

    send(entries, paths)
      .then(finish)
      .catch(function (err) {
        setWorking(false);

        // Leave the rows on screen and mark the ones at fault, so the message
        // above the list and the file it refers to are visible together
        paths.forEach(function (path) {
          setFileState(path, "", null);
        });

        (err.problems || []).forEach(function (problem) {
          if (problem.path) setFileState(problem.path, "Problem", "problem");
        });

        setLabel(
          paths.length === 1 ? "1 file" : paths.length + " files"
        );

        showError(err.message, err.problems);
      });
  }

  function handleDropped(dataTransfer) {
    collect
      .collectDroppedFiles(dataTransfer)
      .then(upload)
      .catch(function () {
        showError(
          "That folder could not be read. Try choosing it instead.",
          []
        );
      });
  }

  // Without this the browser navigates away to display a dropped file
  function preventNavigation(event) {
    if (collect.hasFileDragPayload(event.dataTransfer)) event.preventDefault();
  }

  window.addEventListener("dragover", preventNavigation);
  window.addEventListener("drop", preventNavigation);

  if (dismiss) {
    dismiss.addEventListener("click", function (event) {
      event.preventDefault();
      hideNotices();
    });
  }

  if (clear) {
    clear.addEventListener("click", function (event) {
      event.preventDefault();
      if (working) return;
      hideNotices();
      showEmptyState();
    });
  }

  dropzone.addEventListener("dragenter", function (event) {
    if (!collect.hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth += 1;
    dropzone.classList.add("is-dragover");
  });

  dropzone.addEventListener("dragover", function (event) {
    if (!collect.hasFileDragPayload(event.dataTransfer)) return;
    event.preventDefault();
  });

  dropzone.addEventListener("dragleave", function (event) {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove("is-dragover");
  });

  dropzone.addEventListener("drop", function (event) {
    dragDepth = 0;
    dropzone.classList.remove("is-dragover");

    if (!collect.hasFileDragPayload(event.dataTransfer)) return;

    event.preventDefault();
    handleDropped(event.dataTransfer);
  });

  [folderInput, zipInput].forEach(function (input) {
    if (!input) return;
    input.addEventListener("change", function () {
      // Dismissing the file picker without choosing anything is not an empty
      // folder, so leave the panel as it was rather than complaining
      if (input.files && input.files.length) {
        upload(collect.collectSelectedFiles(input));
      }

      // Let the same folder be chosen again after a failure
      input.value = "";
    });
  });
}

if (typeof document !== "undefined") {
  document.querySelectorAll("[data-template-upload]").forEach(init);
}

module.exports = { init: init, isZip: isZip };
