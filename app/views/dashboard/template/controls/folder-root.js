const ajax = require("../js/ajax.js");
const withAjax = ajax.withAjax;
const handleAjaxSaveResponse = ajax.handleAjaxSaveResponse;

const MISSING = "This folder doesn't exist";

// Folder picker: a text field with suggestions from the blog's directories.
// Typing "/Posts/2" suggests the directories inside "/Posts", fetched one
// level at a time from the template's /folders route.
document.querySelectorAll("form.folder-input").forEach(function (form) {
  const input = form.querySelector('input[type="text"]');
  const list = form.querySelector("datalist");
  const errorNode = form.querySelector(".folder-input__error");
  const foldersURL = form.getAttribute("data-folders-url");
  const levels = {};

  const showError = function (message) {
    errorNode.textContent = message || "";
    errorNode.hidden = !message;
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };

  const load = function (path) {
    if (!levels[path]) {
      levels[path] = fetch(foldersURL + "?path=" + encodeURIComponent(path), {
        headers: { Accept: "application/json" },
      })
        .then(function (response) {
          return response.ok ? response.json() : { error: true };
        })
        .catch(function () {
          return { error: true };
        });
    }
    return levels[path];
  };

  // "/Posts/2" -> "/Posts", "/Po" -> "/", "" -> "/"
  const parentOf = function (value) {
    const trimmed = value.trim();
    const slash = trimmed.lastIndexOf("/");
    return slash > 0 ? trimmed.slice(0, slash) : "/";
  };

  const suggest = function () {
    const parent = parentOf(input.value);

    load(parent).then(function (level) {
      if (!level.directories || parentOf(input.value) !== parent) return;

      list.textContent = "";
      level.directories.forEach(function (name) {
        const option = document.createElement("option");
        option.value = (level.path === "/" ? "" : level.path) + "/" + name;
        list.appendChild(option);
      });
    });
  };

  input.addEventListener("focus", suggest);
  input.addEventListener("input", suggest);

  input.addEventListener("change", function () {
    const body = new URLSearchParams();

    body.append(input.name, input.value);
    body.append("_csrf", form.querySelector('input[name="_csrf"]').value);

    fetch(withAjax(window.location.href), { method: "post", body })
      .then(function (response) {
        if (response.status === 400) {
          return response
            .json()
            .catch(function () {
              return {};
            })
            .then(function (result) {
              showError(result.error || "This folder can't be used");
            });
        }

        handleAjaxSaveResponse(response);

        // The folder is saved even if it doesn't exist (it may be created
        // later), so say whether it does. An empty field means the default.
        delete levels[input.value.trim() || "/Posts"];
        return load(input.value.trim() || "/Posts").then(function (level) {
          if (level.error) return;
          if (input.value.trim()) input.value = level.path;
          showError(level.exists ? "" : MISSING);
        });
      })
      .catch(function () {});
  });
});
