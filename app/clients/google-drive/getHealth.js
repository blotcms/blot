const health = require("clients/health");

// Temporary: Google suspended the account that owns our Drive worker
// service accounts. Remove this hard-coded error once sync is restored.
const MESSAGE =
  "Google Drive sync is paused because our API access was suspended. We've submitted an appeal and are working on re-establishing syncing using a new method. You can continue to edit your folder, but your site will not update. We'll provide a new username to share the folder with soon.";

async function getHealth() {
  return health.error([
    {
      code: health.CODES.UNAVAILABLE,
      message: MESSAGE,
    },
  ]);
}

getHealth.MESSAGE = MESSAGE;

module.exports = getHealth;
