const resetFromBlot = require("../sync/resetToDrive");
const database = require("../database");
const clfdate = require("helper/clfdate");
const config = require("config");

// Maximum time to wait for the user to complete the setup
// before aborting and requiring them to start again
const SETUP_TIMEOUT = 1000 * 60 * 60 * 2; // 2 hours

// Cancelling setup (disconnect) deletes the account hash outright. The
// background polling loop below writes status fields (nonEmptyFolderShared,
// folderId, etc.) after awaiting slow Drive API calls, so without this guard
// a write that lands after a concurrent disconnect will resurrect a corrupt,
// partial account hash instead of leaving the blog fully disconnected.
async function storeIfAccountExists(blogID, data) {
  const account = await database.blog.get(blogID);
  if (!account) return null;
  await database.blog.store(blogID, data);
  return account;
}

async function finishSetup(blog, drive, email, serviceAccountId) {
  let folderId;
  let folderName;
  let sync;

  const checkWeCanContinue = async () => {
    const account = await database.blog.get(blog.id);

    if (!account) {
      throw new Error("Account missing");
    }

    const { preparing, email: latestEmail, startedSetup } = account;

    // the user has edited their Google Drive account
    // email address so abort the setup and allow the
    // other setup process to start
    if (latestEmail !== email) throw new Error("Email changed");

    // the user has cancelled the setup
    if (!preparing) throw new Error("Permission to set up revoked");

    // if the setup process has been running for too long then abort
    if (startedSetup && Date.now() - startedSetup > SETUP_TIMEOUT) {
      throw new Error("Setup timed out");
    }

    if (account.serviceAccountId !== serviceAccountId) {
      throw new Error("Service account changed");
    }

    return account;
  };

  try {
    // Phase A: wait for an eligible shared folder without the sync lock
    do {
      await checkWeCanContinue();
      console.log(
        clfdate(),
        "Google Drive Client",
        "Checking for empty shared folder..."
      );

      const res = await findEmptySharedFolder(
        blog.id,
        drive,
        email,
        () => {},
        serviceAccountId
      );

      // wait 2 seconds before trying again
      if (!res) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      folderId = res.folderId;
      folderName = res.folderName;
    } while (!folderId);

    // Phase B: only lock right before mutating sync-critical state
    sync = await establishSyncLock(blog.id);

    const status = sync.folder.status;
    status("Waiting for invite to Google Drive folder");

    await checkWeCanContinue();

    const refreshedFolder = await processFolder(
      { id: folderId, name: folderName },
      drive,
      blog.id,
      status,
      true,
      serviceAccountId
    );

    if (!refreshedFolder) {
      throw new Error("Folder no longer eligible");
    }

    await storeIfAccountExists(blog.id, {
      folderId,
      folderName,
      nonEmptyFolderShared: false,
      nonEditorPermissions: false,
    });

    await checkWeCanContinue();
    status("Ensuring new folder is in sync");

    await resetFromBlot(blog.id, status, { publishSyncProgress: true });

    await storeIfAccountExists(blog.id, { preparing: false });
    status("All files transferred");
  } catch (e) {
    console.log(clfdate(), "Google Drive Client", e);

    let error = "Failed to set up account";

    if (e.message === "Email changed") {
      // don't store this error, the user is changing their email
      // we just want to stop the current setup process
      error = null;
    }

    if (e.message === "Permission to set up revoked") {
      error = null;
    }

    // check that the blog still exists in the database
    const existingBlog = await database.blog.get(blog.id);

    if (existingBlog) {
      await database.blog.store(blog.id, {
        error,
        folderId: null,
        folderName: null,
      });
    }
  } finally {
    if (sync && typeof sync.done === "function") {
      sync.done(null, () => {});
    }
  }
}

/**
 * Find an empty shared folder that can be used for syncing.
 */
async function findEmptySharedFolder(blogID, drive, email, status, serviceAccountId) {
  // Get all shared folders owned by email that aren't already in use
  const existingFolderIDs = await getExistingFolderIDs(email);
  const availableFolders = await getAvailableFolders(
    drive,
    email,
    existingFolderIDs
  );

  if (availableFolders.length === 0) {
    await storeIfAccountExists(blogID, {
      nonEmptyFolderShared: false,
      nonEditorPermissions: false,
    });
    return null;
  }

  // Process each folder, only storing status for the last unsuccessful one
  for (let i = 0; i < availableFolders.length; i++) {
    const folder = availableFolders[i];
    const isLastFolder = i === availableFolders.length - 1;

    const result = await processFolder(
      folder,
      drive,
      blogID,
      status,
      isLastFolder,
      serviceAccountId
    );
    if (result) return result;
  }

  return null;
}

// When the number of google drive, this will get expensive
// we might need to add a way to check if a folderId is already in use
async function getExistingFolderIDs(email) {
  const existingIDs = [];
  await database.blog.iterate(async (blogID, account) => {
    if (account?.folderId && account.email === email) {
      existingIDs.push(account.folderId);
    }
  });
  return existingIDs;
}

async function getAvailableFolders(drive, email, existingIDs) {
  const allFiles = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      pageSize: 100,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      corpora: "allDrives",
      includeItemsFromAllDrives: true,
      orderBy: 'sharedWithMeTime desc',
      fields: "nextPageToken, files(id, name, parents, kind, mimeType, owners, sharingUser(emailAddress))",
      q: `trashed = false and 
          sharedWithMe = true and 
          mimeType = 'application/vnd.google-apps.folder'`,
    });

    allFiles.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);

  console.log(clfdate(), 'Google Drive Client', 'getAvailableFolders:', allFiles.length);

  // filter out folders whose sharingUser is not the same as the email, or whose owners do not include the email
  const filteredFolders = allFiles.filter(
    (file) => file.sharingUser?.emailAddress === email || file.owners && file.owners.some(owner => owner.emailAddress === email)
  );

  console.log(clfdate(), 'Google Drive Client', 'filteredFolders:', filteredFolders.length);

  // filter out folders already in use
  // and folders with a defined (non-undefined) parents array
  // by removing folders with parents we avoid syncing to folders
  // that are inside other folders the service account may have access to
  const filteredFoldersNotInUse = filteredFolders.filter(
    (file) => !existingIDs.includes(file.id) && !file.parents
  );

  console.log(clfdate(), 'Google Drive Client', 'filteredFoldersNotInUse:', filteredFoldersNotInUse.length);

  return filteredFoldersNotInUse;
}

async function processFolder(folder, drive, blogID, status, isLastFolder, serviceAccountId) {
  // Check folder contents
  const folderContents = await drive.files.list({
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    q: `'${folder.id}' in parents and trashed = false`,
  });

  const isEmpty = folderContents.data.files.length === 0;

  // If folder is not empty and blog folder is not empty, skip
  if (!isEmpty) {
    if (isLastFolder) {
      status("Waiting for invite to empty Google Drive folder");
      await storeIfAccountExists(blogID, {
        nonEmptyFolderShared: true,
        nonEditorPermissions: false,
      });
    }
    return null;
  }

  // Check permissions
  const hasEditorPermission = await checkEditorPermissions(
    drive,
    folder.id,
    serviceAccountId
  );

  if (!hasEditorPermission) {
    if (isLastFolder) {
      status("Waiting for editor permission on Google Drive folder");
      await storeIfAccountExists(blogID, {
        nonEditorPermissions: true,
        nonEmptyFolderShared: false,
      });
    }
    return null;
  }

  // Return folder if it's valid
  return {
    folderId: folder.id,
    folderName: folder.name,
  };
}

function getServiceAccountEmail(serviceAccountId) {
  const serviceAccount = config.google_drive.service_accounts.find(
    (credentials) => credentials.client_id === serviceAccountId
  );

  return serviceAccount?.client_email;
}

async function checkEditorPermissions(drive, folderId, serviceAccountId) {
  const serviceAccountEmail = getServiceAccountEmail(serviceAccountId);

  if (!serviceAccountEmail) {
    return false;
  }

  try {
    const permissionsRes = await drive.permissions.list({
      fileId: folderId,
      supportsAllDrives: true,
      fields: "permissions(role,type,emailAddress)",
    });

    const permissions = permissionsRes.data.permissions || [];

    // for regular folders shared from personal drives,
    // the permission role we need is 'writer'
    // for regular folders shared from shared drives,
    // the permission role we need is 'fileOrganizer'
    return permissions.some(
      (perm) =>
        perm.type === "user" &&
        perm.emailAddress === serviceAccountEmail &&
        (perm.role === "writer" || perm.role === "fileOrganizer" || perm.role === "organizer")
    );
  } catch (e) {
    console.error(
      clfdate(),
      "Google Drive Client",
      "Failed to load permissions",
      e.message
    );
    return false;
  }
}

const establishSyncLock = require("sync/establishSyncLock");
const createDriveClient = require("../serviceAccount/createDriveClient");
const { promisify } = require("util");
const getBlog = promisify(require("models/blog").get);

async function restartSetupProcesses() {
  console.log(clfdate(), "Google Drive Client", "Restarting setup processes");

  const blogsToRestart = [];

  try {
    await database.blog.iterate(async (blogID, account) => {
      if (
        // Only attempt to restart if the account is stuck in 'preparing' state
        account?.preparing &&
        // And it has a service account ID
        account?.serviceAccountId &&
        // And it doesn't have a folder ID yet
        !account?.folderId
      ) {
        blogsToRestart.push({ blogID, account });
      }
    });
  } catch (e) {
    console.log(
      clfdate(),
      "Google Drive Client",
      "restartSetupProcesses: Failed to load blogs",
      e
    );
    return;
  }

  for (const { blogID, account } of blogsToRestart) {
    console.log(
      clfdate(),
      "Google Drive Client",
      "Restarting setup for blog",
      blogID
    );

    const serviceAccountId = account.serviceAccountId;
    const email = account.email;

    if (!serviceAccountId || !email) {
      console.log(
        clfdate(),
        "Google Drive Client",
        "Missing serviceAccountId or email",
        blogID
      );
      continue;
    }

    let blog;

    try {
      blog = await getBlog({ id: blogID });

      if (!blog) {
        throw new Error("Blog no longer exists");
      }
    } catch (e) {
      console.log(
        clfdate(),
        "Google Drive Client",
        "Failed to load blog or account details",
        e
      );
      continue;
    }

    let drive;

    try {
      drive = await createDriveClient(serviceAccountId);
    } catch (e) {
      console.log(
        clfdate(),
        "Google Drive Client",
        "Failed to create drive client"
      );
      continue;
    }

    finishSetup(blog, drive, email, serviceAccountId);
  }
}

module.exports = finishSetup;
module.exports.restartSetupProcesses = restartSetupProcesses;
