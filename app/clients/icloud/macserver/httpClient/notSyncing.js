// Blot's answer when it won't sync a blog at all, which no retry can change:
// 400 when the blog has no iCloud account (disconnected while actions were
// queued), 410 when it is deleted, disabled or switched to another client
// (routes/site/middleware/loadAccount.js). The macserver drops the change and
// asks for no resync; it keeps watching, so a blog enabled again syncs.
export const isNotSyncing = (error) =>
  Boolean(error && (error.status === 400 || error.status === 410));
