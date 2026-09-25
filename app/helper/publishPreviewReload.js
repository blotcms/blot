const client = require("models/client");

// Preview pages subscribe to this channel and reload. Folder sync publishes
// after it bumps cacheID; template editor saves of package.json locals do too,
// because those updates never enter the folder sync.
function channel(blogID) {
  return "blog:" + blogID + ":preview:reload";
}

function publish(blogID) {
  if (!blogID || blogID === "SITE") return Promise.resolve();

  try {
    return Promise.resolve(client.publish(channel(blogID), "reload")).catch(
      function (err) {
        console.error(
          "Failed to publish preview reload event",
          err && err.message
        );
      }
    );
  } catch (err) {
    console.error(
      "Failed to publish preview reload event",
      err && err.message
    );
    return Promise.resolve();
  }
}

module.exports = {
  channel: channel,
  publish: publish,
};
