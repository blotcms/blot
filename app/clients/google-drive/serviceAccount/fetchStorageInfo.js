const database = require("../database/serviceAccount"); // Path to serviceAccount database module

const clfdate = require("helper/clfdate");
const prefix = () => `${clfdate()} Google Drive client:`;

// Refresh a single service account's statistics and store the service account email
// so we can share it with users who are connecting their folder with Google Drive
module.exports = async (serviceAccountId, drive) => {
  if (!serviceAccountId || !drive) {
    throw new Error("Both serviceAccountId and drive are required.");
  }

  console.log(
    prefix(),
    `Service account client_id=${serviceAccountId} Fetching storage quota`
  );

  try {
    const res = await drive.about.get({
      fields: "storageQuota, user",
    });

    const { storageQuota, user } = res.data;

    if (
      !storageQuota ||
      storageQuota.usage == null ||
      storageQuota.limit == null
    ) {
      throw new Error("Invalid storageQuota response from Google API.");
    }

    console.log(
      prefix(),
      `Service account client_id=${serviceAccountId} ${
        storageQuota.usage / 1024 / 1024
      } MB used of ${storageQuota.limit / 1024 / 1024} MB`
    );

    // Store service account data in the database
    await database.store(serviceAccountId, { storageQuota, user });

    console.log(
      prefix(),
      `Service account client_id=${serviceAccountId} updated successfully.`
    );
  } catch (e) {
    console.error(
      prefix(),
      `Service account client_id=${serviceAccountId} failed to update.`,
      e.message
    );
  }
};
