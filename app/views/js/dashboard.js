require("./localforage.js");
require("./folder-toast.js");
require("./new-template-files.js");
require("./form-buttons.js");
require("./focus-input.js");
require("./determine-timezone.js");
require("./redirects.js");
require("./account-create-site-paypal.js");
require("./paypal-revise-button.js");
require("./account-card-form.js");
require("./dashboard-login.js");
require("./reconnecting-event-source.js");
require("./dashboard-import.js");
require("./file-drop.js");
require("./site-preview-path-sync.js");
require("./domain-record-guide.js");
require("./domain-custom.js");
require("./site-settings-services.js");
require("./site-settings-autosubmit.js");
require("./site-settings-links.js");
require("./site-settings-images.js");
require("./site-settings-redirects.js");
var initSidebarActionMenu = require("../dashboard/template/js/sidebar-action-menu.js");

if (typeof window !== "undefined" && window.__folderFileActionMenuConfig) {
  var folderConfig = window.__folderFileActionMenuConfig;
  initSidebarActionMenu({
    container: folderConfig.container,
    menuElement: folderConfig.menuElement,
    rowSelector: folderConfig.rowSelector,
    triggerSelector: folderConfig.triggerSelector,
    linkMap: folderConfig.linkMap,
  });
  delete window.__folderFileActionMenuConfig;
}
