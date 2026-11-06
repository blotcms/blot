const guid = require("helper/guid");
const database = require("clients/google-drive/database");
const clfdate = require("helper/clfdate");
const prefix = () => `${clfdate()} Google Drive client:`;

const config = require("config");
const WEBHOOK_HOST = config.environment === "development" ? config.webhooks.relay_host : config.host;
const CHANNEL_EXPIRATION_TIME = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

module.exports = async function watchChanges(serviceAccountId, drive) {
  if (!serviceAccountId || !drive) {
    throw new Error("Both serviceAccountId and drive are required.");
  }

  const now = Date.now();

  console.log(prefix(), `Service account client_id=${serviceAccountId} Ensuring service account is watching for changes`);

  // Step 1: Check for existing valid channels
  const existingChannels = await database.channel.listByServiceAccount(serviceAccountId);
  if (existingChannels && existingChannels.length > 0) {
    for (const channelId of existingChannels) {
      const channelData = await database.channel.get(channelId);

      if (
        channelData &&
        channelData.type === "changes.watch" &&
        channelData.expiration &&
        Number(channelData.expiration) - now > 20 * 60 * 1000
      ) {
        console.log(
          prefix(),
          `Service account client_id=${serviceAccountId} Existing channel ${channelId} is valid and will expire in ${
            (Number(channelData.expiration) - now) / 1000 / 60
          } minutes`
        );
        return;
      }
    }
  }

  console.log(prefix(), `Service account client_id=${serviceAccountId} Setting up new changes.watch channel`);

  // Step 2: Set up a new channel
  const channelId = guid();
  const expirationTime = now + CHANNEL_EXPIRATION_TIME;

  let startPageToken;
  try {
    startPageToken = (
      await drive.changes.getStartPageToken({ 
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
     })
    ).data.startPageToken;
  } catch (err) {
    throw new Error(`Failed to fetch startPageToken: ${err.message}`, { cause: err });
  }

  const watchRequest = {
    id: channelId,
    type: "web_hook",
    address: `https://${WEBHOOK_HOST}/clients/google-drive/webhook/changes.watch/${serviceAccountId}`,
    expiration: expirationTime,
  };

  let response;
  try {
    response = await drive.changes.watch({
      pageToken: startPageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      requestBody: watchRequest,
    });
    if (!response.data.id || !response.data.resourceId || !response.data.expiration) {
      throw new Error("Invalid response from changes.watch API");
    }
  } catch (err) {
    throw new Error(`Failed to set up changes.watch channel: ${err.message}`, { cause: err });
  }

  console.log(
    prefix(),
    `Service account client_id=${serviceAccountId} New changes.watch channel created: channelId=${response.data.id}, expiration=${response.data.expiration}`
  );

  const newChannel = {
    type: "changes.watch",
    serviceAccountId,
    channelId: response.data.id,
    resourceId: response.data.resourceId,
    expiration: response.data.expiration,
  };
  await database.channel.store(response.data.id, newChannel);

  // Step 3: Stop old channels
  if (existingChannels && existingChannels.length > 0) {
    await Promise.all(
      existingChannels.map(async (oldChannelId) => {
        const oldChannelData = await database.channel.get(oldChannelId);
        if (oldChannelData && oldChannelData.type === "changes.watch") {
          try {
            await drive.channels.stop({
              requestBody: {
                id: oldChannelData.channelId,
                resourceId: oldChannelData.resourceId,
              },
            });
          } catch (err) {
            console.error(
              prefix(),
              `Failed to stop old changes.watch channel for serviceAccountId=${serviceAccountId}, channelId=${oldChannelData.channelId}: ${err.message}`
            );
          }
          await database.channel.delete(oldChannelId);
        }
      })
    );
  }
};