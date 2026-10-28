document.querySelectorAll("[data-file-drop]").forEach(function (root) {
  const input = root.querySelector(".file-drop__input");
  const empty = root.querySelector("[data-file-drop-empty]");
  const selected = root.querySelector("[data-file-drop-selected]");
  const nameNode = root.querySelector("[data-file-drop-name]");
  const clear = root.querySelector("[data-file-drop-clear]");
  const form = root.closest("form");
  const actions = form && form.querySelector("[data-file-drop-actions]");

  if (!input || !empty || !selected || !nameNode) return;

  let dragDepth = 0;

  function hasFile() {
    return input.files && input.files.length > 0;
  }

  function sync() {
    const file = hasFile() ? input.files[0] : null;

    if (file) {
      empty.hidden = true;
      selected.hidden = false;
      nameNode.textContent = file.name;
    } else {
      empty.hidden = false;
      selected.hidden = true;
      nameNode.textContent = "";
    }

    if (actions) actions.hidden = !file;
  }

  function setFiles(fileList) {
    if (!fileList || !fileList.length) {
      input.value = "";
      sync();
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    let assigned = false;
    try {
      const transfer = new DataTransfer();
      transfer.items.add(fileList[0]);
      input.files = transfer.files;
      assigned = true;
    } catch (e) {
      // DataTransfer assignment unsupported; rely on native input change only
    }

    if (assigned) input.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
  }

  input.addEventListener("change", sync);

  if (clear) {
    clear.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      sync();
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  root.addEventListener("dragenter", function (event) {
    event.preventDefault();
    dragDepth += 1;
    root.classList.add("is-dragover");
  });

  root.addEventListener("dragover", function (event) {
    event.preventDefault();
  });

  root.addEventListener("dragleave", function (event) {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) root.classList.remove("is-dragover");
  });

  root.addEventListener("drop", function (event) {
    event.preventDefault();
    dragDepth = 0;
    root.classList.remove("is-dragover");
    setFiles(event.dataTransfer && event.dataTransfer.files);
  });

  sync();
});
