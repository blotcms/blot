const pendingSyncs = new Map();
const pendingUpdates = new Map();

const ensureSyncSet = (blogID) => {
  if (!pendingSyncs.has(blogID)) {
    pendingSyncs.set(blogID, new Set());
  }
  return pendingSyncs.get(blogID);
};

const ensureUpdateMap = (blogID) => {
  if (!pendingUpdates.has(blogID)) {
    pendingUpdates.set(blogID, new Map());
  }
  return pendingUpdates.get(blogID);
};

const ensureUpdateSet = (blogID, syncID) => {
  const blogMap = ensureUpdateMap(blogID);
  if (!blogMap.has(syncID)) {
    blogMap.set(syncID, new Set());
  }
  return blogMap.get(syncID);
};

const addPendingSync = (blogID, syncID) => {
  if (!blogID || !syncID) return;
  ensureSyncSet(blogID).add(syncID);
};

const removePendingSync = (blogID, syncID) => {
  if (!blogID || !syncID) return;
  const syncSet = pendingSyncs.get(blogID);
  if (syncSet) {
    syncSet.delete(syncID);
    if (syncSet.size === 0) {
      pendingSyncs.delete(blogID);
    }
  }

  const blogMap = pendingUpdates.get(blogID);
  if (blogMap) {
    blogMap.delete(syncID);
    if (blogMap.size === 0) {
      pendingUpdates.delete(blogID);
    }
  }
};

const addPendingUpdate = (blogID, syncID, filePath) => {
  if (!blogID || !syncID || !filePath) return;
  ensureUpdateSet(blogID, syncID).add(filePath);
};

const removePendingUpdate = (blogID, syncID, filePath) => {
  if (!blogID || !syncID || !filePath) return;
  const blogMap = pendingUpdates.get(blogID);
  if (!blogMap) return;

  const fileSet = blogMap.get(syncID);
  if (!fileSet) return;

  fileSet.delete(filePath);
  if (fileSet.size === 0) {
    blogMap.delete(syncID);
  }
  if (blogMap.size === 0) {
    pendingUpdates.delete(blogID);
  }
};

const getPendingSyncs = () => {
  const entries = [];
  for (const [blogID, syncSet] of pendingSyncs.entries()) {
    for (const syncID of syncSet.values()) {
      entries.push({ blogID, syncID });
    }
  }
  return entries;
};

const getPendingUpdates = () => {
  const entries = [];
  for (const [blogID, blogMap] of pendingUpdates.entries()) {
    for (const [syncID, fileSet] of blogMap.entries()) {
      for (const filePath of fileSet.values()) {
        entries.push({ blogID, syncID, filePath });
      }
    }
  }
  return entries;
};

module.exports = {
  addPendingSync,
  removePendingSync,
  addPendingUpdate,
  removePendingUpdate,
  getPendingSyncs,
  getPendingUpdates,
};
