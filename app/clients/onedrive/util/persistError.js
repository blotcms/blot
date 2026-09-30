const { promisify } = require("util");
const database = require("../database");
const { classify } = require("./classifyError");

const getAccount = promisify(database.get);
const setAccount = promisify(database.set);

// Stores a user-actionable error on the blog's account so getHealth and
// the dashboard can report it. Transient failures are ignored, so a
// durable error (e.g. 401) isn't overwritten by a later 500, and a
// healthy account isn't marked broken by a blip. Never throws: it's
// called while another error is already being handled.
async function persistError(blogID, err, source) {
  try {
    const classified = classify(err, source);

    if (!classified.persist) return;

    const account = await getAccount(blogID);

    if (!account) return;

    await setAccount(blogID, {
      error_code: classified.status,
      // Keep the original time if this is the same ongoing problem
      error_since:
        account.error_code === classified.status && account.error_since
          ? account.error_since
          : Date.now(),
    });
  } catch (e) {
    console.error("OneDrive: failed to persist error for", blogID, e);
  }
}

// Called after a step that proves the account is healthy again.
async function clearError(blogID) {
  const account = await getAccount(blogID);

  if (!account || !account.error_code) return;

  await setAccount(blogID, { error_code: 0, error_since: 0 });
}

module.exports = { persistError, clearError };
