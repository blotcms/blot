const database = require("clients/google-drive/database");
const config = require("config");
const email = require("helper/email");
const clfdate = require("helper/clfdate");

const MIN_FREE_SPACE_BYTES = 5 * 1024 * 1024 * 1024; // 1 GB
const WARN_FREE_SPACE_BYTES = 10 * 1024 * 1024 * 1024; // 5 GB

const prefix = () => `${clfdate()} Google Drive:`;

// Select a service account for a blog
// We query the database to retrieve all the service accounts, then
// sort them by the available space (storageQuota.available - storageQuota.used)
// to find the one with the most available space.
module.exports = async function () {
  // Fetch the list of all service account IDs from the database
  const serviceAccountIds = await database.serviceAccount.list();

  if (!serviceAccountIds || serviceAccountIds.length === 0) {
    throw new Error("No service accounts found in the database.");
  }

  // Retrieve details for all service accounts
  const allServiceAccounts = [];
  for (const serviceAccountId of serviceAccountIds) {
    const account = await database.serviceAccount.get(serviceAccountId);
    if (account) {
      allServiceAccounts.push({ serviceAccountId, ...account });
    }
  }

  if (allServiceAccounts.length === 0) {
    throw new Error("No valid service accounts found in the database.");
  }

  // Filter service accounts based on valid credentials from the config
  const validServiceAccounts = allServiceAccounts.filter((account) =>
    config.google_drive.service_accounts.some(
      (credentials) => credentials.client_id === account.serviceAccountId
    )
  );

  if (validServiceAccounts.length === 0) {
    throw new Error(
      "No service accounts with valid credentials found in the database."
    );
  }

  let oneAccountHasPlentyOfSpace = false;

  // Log all accounts and their free space
  validServiceAccounts.forEach((account) => {
    const freeSpace = account.storageQuota.limit - account.storageQuota.usage;
    if (freeSpace >= WARN_FREE_SPACE_BYTES) {
      oneAccountHasPlentyOfSpace = true;
    }
    console.log(
      prefix(),
      `Service account ${account.serviceAccountId} has ${freeSpace} bytes of free space.`
    );
  });

  if (!oneAccountHasPlentyOfSpace) {
    console.log(
      prefix(),
      "No service accounts with plenty of free space found."
    );
    email.GOOGLE_DRIVE_SERVICE_ACCOUNT_LOW();
  }

  // Filter service accounts that have less than the minimum free space
  const validServiceAccountsWithFreeSpace = validServiceAccounts.filter(
    (account) => {
      const freeSpace = account.storageQuota.limit - account.storageQuota.usage;
      return freeSpace >= MIN_FREE_SPACE_BYTES;
    }
  );

  if (!validServiceAccountsWithFreeSpace.length) {
    throw new Error(
      "No service accounts with enough free space found in the database."
    );
  }

  // Calculate the number of blogs currently using each service account
  for (const account of validServiceAccountsWithFreeSpace) {
    let totalBlogs = 0;
    await database.blog.iterateByServiceAccountId(
      account.serviceAccountId,
      (blogID) => totalBlogs++
    );
    account.blogs = totalBlogs;
  }

  // Sort service accounts by number of blogs using them
  validServiceAccountsWithFreeSpace.sort((a, b) => {
    return a.blogs - b.blogs;
  });

  // Select the service account with the fewest blogs
  const selectedAccount = validServiceAccountsWithFreeSpace[0];

  const selectedFreeSpace =
    selectedAccount.storageQuota.limit - selectedAccount.storageQuota.usage;
  console.log(
    prefix(),
    `Selected service account: ${selectedAccount.blogs} blogs, ${selectedAccount.serviceAccountId} with ${selectedFreeSpace} bytes of free space.`
  );

  // Check to see if we need to warn about low free space

  // Return the selected service account's client ID
  return selectedAccount.serviceAccountId;
};
