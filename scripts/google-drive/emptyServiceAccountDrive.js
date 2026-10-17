const config = require("config");
const { drive: createDrive, auth: googleAuth } = require("@googleapis/drive");
const database = require("clients/google-drive/database");

const prefix = () => {
  const date = new Date();
  return `${date.toISOString()} Google Drive client:`;
};

// Utility to delete permissions for shared folders
const removeSharedFolderAccess = async (drive, file) => {
  try {
    const permissions = await drive.permissions.list({
      fileId: file.id,
      fields: "permissions(id, emailAddress, role, type)",
    });

    for (const permission of permissions.data.permissions) {
      if (permission.type === "user" && permission.role !== "owner") {
        await drive.permissions.delete({
          fileId: file.id,
          permissionId: permission.id,
        });
        console.log(
          prefix(),
          `Removed shared folder access for file: ${file.name} (ID: ${file.id}, Permission ID: ${permission.id})`
        );
      }
    }
  } catch (err) {
    console.error(
      prefix(),
      `Failed to remove shared folder access for file: ${file.name} (ID: ${file.id}). Error: ${err.message}`
    );
  }
};

// Utility to handle file deletion with error handling
const deleteFile = async (drive, file) => {
  try {
    if (file.mimeType === "application/vnd.google-apps.folder") {
      await removeSharedFolderAccess(drive, file);
    }
    await drive.files.delete({ fileId: file.id });
    console.log(prefix(), `Deleted file/folder with ID: ${file.id}`);
  } catch (err) {
    console.error(
      prefix(),
      `Failed to delete file/folder with ID: ${file.id}. Error: ${err.message}`
    );
  }
};

const processServiceAccount = async (credentials) => {
  const auth = new googleAuth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  const drive = createDrive({ version: "v3", auth });

  try {
    const res = await drive.about.get({
      fields: "user, storageQuota",
    });
    console.log(
      prefix(),
      `Service account client_id=${credentials.client_id}`,
      `${(res.data.storageQuota.usage / 1024 / 1024).toFixed(2)} MB of`,
      `${(res.data.storageQuota.limit / 1024 / 1024).toFixed(2)} MB used`
    );
    await database.serviceAccount.set(credentials.client_id, res.data);

    let pageToken = null;
    do {
      const files = await drive.files.list({
        fields: "nextPageToken, files(id, name, mimeType, shared)",
        spaces: "drive",
        pageToken: pageToken || undefined,
      });

      for (const file of files.data.files) {
        console.log(
          prefix(),
          `Processing file/folder: ${file.name} (ID: ${file.id}, Type: ${file.mimeType}, Shared: ${file.shared})`
        );
        await deleteFile(drive, file);
      }

      pageToken = files.data.nextPageToken;
    } while (pageToken);

    try {
      await drive.files.emptyTrash();
      console.log(prefix(), "Trash emptied successfully.");
    } catch (err) {
      console.error(prefix(), "Failed to empty trash. Error:", err.message);
    }

    const res2 = await drive.about.get({
      fields: "user, storageQuota",
    });
    console.log(
      prefix(),
      `Service account client_id=${credentials.client_id}`,
      `${(res2.data.storageQuota.usage / 1024 / 1024).toFixed(2)} MB of`,
      `${(res2.data.storageQuota.limit / 1024 / 1024).toFixed(2)} MB used after cleanup`
    );
  } catch (err) {
    console.error(
      prefix(),
      `Failed to process service account client_id=${credentials.client_id}. Error: ${err.message}`
    );
  }
};

const processSingleAccount = async (clientId) => {
  const serviceAccount = config.google_drive.service_accounts.find(
    (account) => account.client_id === clientId
  );

  if (!serviceAccount) {
    throw new Error(`Service account with client_id=${clientId} not found.`);
  }

  console.log(
    prefix(),
    `Starting cleanup for service account client_id=${serviceAccount.client_id}`
  );
  await processServiceAccount(serviceAccount);
  console.log(
    prefix(),
    `Finished cleanup for service account client_id=${serviceAccount.client_id}`
  );
};

// Retrieve client_id from command line arguments
const clientId = process.argv[2];
if (!clientId) {
  console.error(
    prefix(),
    "No client_id specified. Usage: node script.js <client_id>"
  );
  process.exit(1);
}

// Start processing the specified account
processSingleAccount(clientId)
  .then(() => console.log(prefix(), "Specified service account processed successfully."))
  .catch((err) =>
    console.error(
      prefix(),
      `Error processing service account with client_id=${clientId}. Error:`,
      err.message
    )
  )
  .finally(() => process.exit(0));