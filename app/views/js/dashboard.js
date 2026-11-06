// Dashboard pages load this bundle only, not documentation.min.js
require("./sync_status.js");
require("./global-sync.js");
require("./sites-sync.js");
require("./instant.page.js");
// must come before copy-buttons.js, which adds buttons to its tabs
require("./multi-lingual-code.js");
require("./copy-buttons.js");
require("./code-copy-buttons.js");
require("./folder-toast.js");
require("./folder-directory.js");
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
require("./dashboard-message.js");
require("./site-settings-links.js");
require("./site-settings-images.js");
require("./site-settings-redirects.js");
require("./dashboard-sidebar.js");
require("./data-table.js");
require("./details-dismiss.js");
require("../dashboard/template/js/template-overview.js");
require("./template-screenshots.js");
require("../dashboard/template/js/template-link-hints.js");
var initRowMenu = require("./row-menu.js");

if (typeof window !== "undefined" && window.__folderFileActionMenuConfig) {
  var folderConfig = window.__folderFileActionMenuConfig;
  initRowMenu({
    container: folderConfig.container,
    menuElement: folderConfig.menuElement,
    rowSelector: folderConfig.rowSelector,
    triggerSelector: folderConfig.triggerSelector,
    linkMap: folderConfig.linkMap,
  });
  delete window.__folderFileActionMenuConfig;
}

// The sites table: each row's "..." button carries that site's URLs
if (typeof document !== "undefined") {
  var sitesMenu = document.getElementById("sites-row-menu");
  var sitesTable = document.querySelector(".sites-table");
  if (sitesMenu && sitesTable) {
    var sitesLink = function (name) {
      return function (dataset) {
        return dataset[name];
      };
    };
    initRowMenu({
      container: sitesTable.closest(".sites-list-container") || sitesTable,
      menuElement: sitesMenu,
      rowSelector: ".sites-table__row",
      triggerSelector: ".row-action-menu__trigger",
      initialFocusKey: "overview",
      linkMap: {
        overview: sitesLink("overviewUrl"),
        visit: sitesLink("visitUrl"),
        template: sitesLink("templateUrl"),
        settings: sitesLink("settingsUrl"),
        delete: sitesLink("deleteUrl"),
      },
    });
  }
}
