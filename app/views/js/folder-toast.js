var announce = require("./announce.js");

/**
 * Folder toast: top-center confirmation toasts for download, upload, remove.
 * Usage: showFolderToast('Message') or showFolderToast({ message: '...', type: 'success' })
 */
function showFolderToast(messageOrOptions) {
  var message =
    typeof messageOrOptions === "string"
      ? messageOrOptions
      : (messageOrOptions && messageOrOptions.message) || "";
  var type = (messageOrOptions && messageOrOptions.type) || "success";

  var root = document.getElementById("folder-toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "folder-toast-root";
    document.body.appendChild(root);
  }

  var toast = document.createElement("div");
  toast.className = "folder-toast";

  var icon = document.createElement("span");
  icon.className = "folder-toast__icon folder-toast__icon--" + type;
  if (type === "success") {
    icon.classList.add("icon-small-check");
  }
  toast.appendChild(icon);

  var text = document.createElement("span");
  text.className = "folder-toast__text";
  text.textContent = message;
  toast.appendChild(text);

  root.appendChild(toast);
  announce(message);
  void toast.offsetWidth;
  toast.classList.add("folder-toast--in");

  setTimeout(function () {
    toast.classList.remove("folder-toast--in");
    toast.classList.add("folder-toast--out");
    toast.addEventListener(
      "transitionend",
      function () {
        toast.remove();
      },
      { once: true }
    );
  }, 2200);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = showFolderToast;
}
if (typeof window !== "undefined") {
  window.showFolderToast = showFolderToast;
}
