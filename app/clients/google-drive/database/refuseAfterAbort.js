const { throwIfAborted } = require("storage/folder/guard");

// Makes the named methods of a store throw, before they write anything, when
// they are called for a sync whose folder lock a disconnect has seized
// (sync/seize.js). A cancelled sync then can't bring back records the
// disconnect has just deleted (the account, the folder's mapping, the
// directories waiting to be synced), whichever code path it is in. The
// disconnect itself runs in a context of its own, so its writes go through.
module.exports = function refuseAfterAbort(store, names) {
  for (const name of names) {
    const method = store[name];
    store[name] = async function (...args) {
      throwIfAborted();
      return method.apply(this, args);
    };
  }
  return store;
};
