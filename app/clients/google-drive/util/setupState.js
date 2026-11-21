const { isSetupError } = require("../database/error");

// Where a Google Drive setup has got to, for the dashboard (views/index.html),
// from what routes/setup.js stores on the account as it goes:
//
// 1. Add your Google account: done once the account has an email, which
//    /set-up-folder stores when setup starts.
// 2. Share a folder: the person's step, until Blot finds an empty folder
//    they shared with it as an editor. nonEmptyFolderShared and
//    nonEditorPermissions say what was wrong with the last one it saw.
// 3. Set up the folder: Blot checks the folder again under the sync lock
//    and stores folderId. That takes seconds and stores nothing while it
//    runs, so the page shows it done or waiting, never running.
// 4. Copy your site's files: from folderId until preparing is cleared.
//
// A failed setup keeps preparing beside its error (routes/setup.js), so it
// is a stage of its own, and the page shows Retry instead of the steps.
module.exports = function setupState(account) {
  if (!account) return null;

  let stage;
  if (isSetupError(account.error)) stage = "failed";
  else if (!account.preparing) stage = "complete";
  else if (account.folderId) stage = "copying";
  else stage = "share";

  return {
    stage,
    failed: stage === "failed",
    share: stage === "share",
    copying: stage === "copying",
    complete: stage === "complete",
    // The checklist stays until the copy is done, like iCloud's
    inProgress: stage === "share" || stage === "copying",
    shareProblem: stage === "share" && shareProblem(account),
  };
};

function shareProblem(account) {
  if (account.nonEditorPermissions)
    return "Blot can only view the folder you shared. Share it again and choose Editor.";
  if (account.nonEmptyFolderShared)
    return "The folder you shared has files in it. Share an empty folder.";
  return false;
}
