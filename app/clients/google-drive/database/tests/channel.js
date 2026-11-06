describe("google drive database.channel", function () {
  const database = require("clients/google-drive/database");
  const client = require("models/client");
  const prefix = require("clients/google-drive/database/prefix");

  const channel = database.channel;

  // Before each test, clear all Redis data with the matching prefix
  afterEach(async function () {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length) {
      await client.del(keys);
    }
  });

  it("can create and retrieve a changes.watch channel", async function () {
    const channelId = "channel_" + Date.now().toString();
    const resourceId = "resource_" + Date.now().toString();
    const channelData = {
      type: "changes.watch",
      serviceAccountId: "service_account_1",
      resourceId,
      url: "https://example.com",
    };

    // Create the channel
    await channel.store(channelId, channelData);

    // Retrieve the channel
    const retrievedChannel = await channel.get(channelId);
    expect(retrievedChannel).toEqual(channelData);
  });

  it("can create and retrieve a files.watch channel", async function () {
    const channelId = "channel_" + Date.now().toString();
    const resourceId = "resource_" + Date.now().toString();
    const channelData = {
      type: "files.watch",
      serviceAccountId: "service_account_1",
      fileId: "file_1",
      resourceId,
      url: "https://example.com",
    };

    // Create the channel
    await channel.store(channelId, channelData);

    // Retrieve the channel
    const retrievedChannel = await channel.get(channelId);
    expect(retrievedChannel).toEqual(channelData);
  });

  it("throws an error if type or serviceAccountId is missing", async function () {
    const channelId = "channel_" + Date.now().toString();
    const resourceId = "resource_" + Date.now().toString();

    // Missing type
    const missingTypeData = {
      serviceAccountId: "service_account_1",
      resourceId,
      url: "https://example.com",
    };

    try {
      await channel.store(channelId, missingTypeData);
      fail("Expected an error to be thrown when type is missing");
    } catch (err) {
      expect(err.message).toBe(
        "type and serviceAccountId are required to associate a channel."
      );
    }

    // Missing serviceAccountId
    const missingServiceAccountData = {
      type: "files.watch",
      resourceId,
      fileId: "file_1",
      url: "https://example.com",
    };

    try {
      await channel.store(channelId, missingServiceAccountData);
      fail("Expected an error to be thrown when serviceAccountId is missing");
    } catch (err) {
      expect(err.message).toBe(
        "type and serviceAccountId are required to associate a channel."
      );
    }
  });

  it("can iterate over all channels associated with a serviceAccountId and fileId", async function () {
    const serviceAccountId = "service_account_1";
    const fileId = "file_1";

    // Create channels associated with the service account and file
    const channelId1 = "channel_" + Date.now().toString();
    const resourceId1 = "resource_" + Date.now().toString();
    const channelId2 = "channel_" + (Date.now() + 1).toString();
    const resourceId2 = "resource_" + (Date.now() + 1).toString();

    await channel.store(channelId1, {
      type: "files.watch",
      serviceAccountId,
      fileId,
      resourceId: resourceId1,
      url: "https://example1.com",
    });
    await channel.store(channelId2, {
      type: "files.watch",
      serviceAccountId,
      fileId,
      resourceId: resourceId2,
      url: "https://example2.com",
    });

    // Iterate over all channels associated with the service account and file
    const result = [];
    await channel.iterateByFile(serviceAccountId, fileId, (data) => {
      result.push(data);
    });

    // Expected result
    const expected = [
      {
        type: "files.watch",
        serviceAccountId,
        fileId,
        resourceId: resourceId1,
        url: "https://example1.com",
      },
      {
        type: "files.watch",
        serviceAccountId,
        fileId,
        resourceId: resourceId2,
        url: "https://example2.com",
      },
    ];

    // Sort by resourceId for consistent comparison
    result.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    expected.sort((a, b) => a.resourceId.localeCompare(b.resourceId));

    expect(result).toEqual(expected);
  });

  it("can iterate over all channels associated with a serviceAccountId", async function () {
    const serviceAccountId = "service_account_1";

    // Create channels associated with the service account
    const channelId1 = "channel_" + Date.now().toString();
    const resourceId1 = "resource_" + Date.now().toString();
    const channelId2 = "channel_" + (Date.now() + 1).toString();
    const resourceId2 = "resource_" + (Date.now() + 1).toString();

    await channel.store(channelId1, {
      type: "changes.watch",
      serviceAccountId,
      resourceId: resourceId1,
      url: "https://example1.com",
    });
    await channel.store(channelId2, {
      type: "files.watch",
      serviceAccountId,
      fileId: "file_1",
      resourceId: resourceId2,
      url: "https://example2.com",
    });

    // Iterate over all channels associated with the service account
    const result = [];
    await channel.iterateByServiceAccount(serviceAccountId, (data) => {
      result.push(data);
    });

    // Expected result
    const expected = [
      {
        type: "changes.watch",
        serviceAccountId,
        resourceId: resourceId1,
        url: "https://example1.com",
      },
      {
        type: "files.watch",
        serviceAccountId,
        fileId: "file_1",
        resourceId: resourceId2,
        url: "https://example2.com",
      },
    ];

    // Sort by resourceId for consistent comparison
    result.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    expected.sort((a, b) => a.resourceId.localeCompare(b.resourceId));

    expect(result).toEqual(expected);
  });

  it("can list all channels globally", async function () {
    const channelId1 = "channel_" + Date.now().toString();
    const resourceId1 = "resource_" + Date.now().toString();
    const channelId2 = "channel_" + (Date.now() + 1).toString();
    const resourceId2 = "resource_" + (Date.now() + 1).toString();

    await channel.store(channelId1, {
      type: "changes.watch",
      serviceAccountId: "service_account_1",
      resourceId: resourceId1,
      url: "https://example1.com",
    });
    await channel.store(channelId2, {
      type: "files.watch",
      serviceAccountId: "service_account_2",
      fileId: "file_1",
      resourceId: resourceId2,
      url: "https://example2.com",
    });

    const channelIds = await channel.list();
    expect(channelIds.sort()).toEqual([channelId1, channelId2].sort());
  });

  it("can list all channels associated with a serviceAccountId", async function () {
    const serviceAccountId = "service_account_1";
    const channelId1 = "channel_" + Date.now().toString();
    const resourceId1 = "resource_" + Date.now().toString();
    const channelId2 = "channel_" + (Date.now() + 1).toString();
    const resourceId2 = "resource_" + (Date.now() + 1).toString();

    await channel.store(channelId1, {
      type: "changes.watch",
      serviceAccountId,
      resourceId: resourceId1,
      url: "https://example1.com",
    });
    await channel.store(channelId2, {
      type: "files.watch",
      serviceAccountId,
      fileId: "file_1",
      resourceId: resourceId2,
      url: "https://example2.com",
    });

    const serviceAccountChannels =
      await channel.listByServiceAccount(serviceAccountId);
    expect(serviceAccountChannels.sort()).toEqual(
      [channelId1, channelId2].sort()
    );
  });

  it("gracefully handles deletion of a non-existent channel", async function () {
    const nonExistentChannelId =
      "non_existent_channel_" + Date.now().toString();

    // Attempt to delete a non-existent channel
    await expectAsync(channel.delete(nonExistentChannelId)).toBeResolved();

    // Ensure the non-existent channel is not listed globally
    const channelIds = await channel.list();
    expect(channelIds).not.toContain(nonExistentChannelId);
  });

  it("can list all channels associated with a serviceAccountId and fileId", async function () {
    const serviceAccountId = "service_account_1";
    const fileId = "file_1";
    const channelId = "channel_" + Date.now().toString();
    const resourceId = "resource_" + Date.now().toString();

    await channel.store(channelId, {
      type: "files.watch",
      serviceAccountId,
      fileId,
      resourceId,
      url: "https://example.com",
    });

    const fileChannels = await channel.listByFile(serviceAccountId, fileId);
    expect(fileChannels).toEqual([channelId]);
  });

  it("can delete a channel and clean up related data", async function () {
    const serviceAccountId = "service_account_1";
    const fileId = "file_1";
    const channelId = "channel_" + Date.now().toString();
    const resourceId = "resource_" + Date.now().toString();

    await channel.store(channelId, {
      type: "files.watch",
      serviceAccountId,
      fileId,
      resourceId,
      url: "https://example.com",
    });

    // Ensure the channel exists
    const retrievedChannel = await channel.get(channelId);
    expect(retrievedChannel).toEqual({
      type: "files.watch",
      serviceAccountId,
      fileId,
      resourceId,
      url: "https://example.com",
    });

    // Delete the channel
    await channel.delete(channelId);

    // Ensure the channel is removed
    const deletedChannel = await channel.get(channelId);
    expect(deletedChannel).toBeNull();

    // Ensure the channel is no longer in the global list
    const channelIds = await channel.list();
    expect(channelIds).not.toContain(channelId);

    // Ensure the channel is no longer associated with the service account
    const serviceAccountChannels =
      await channel.listByServiceAccount(serviceAccountId);
    expect(serviceAccountChannels).not.toContain(channelId);

    // Ensure the channel is no longer associated with the file
    const fileChannels = await channel.listByFile(serviceAccountId, fileId);
    expect(fileChannels).not.toContain(channelId);
  });

  it("can iterate over all channels globally", async function () {
    const channelId1 = "channel_" + Date.now().toString();
    const resourceId1 = "resource_" + Date.now().toString();
    const channelId2 = "channel_" + (Date.now() + 1).toString();
    const resourceId2 = "resource_" + (Date.now() + 1).toString();

    await channel.store(channelId1, {
      type: "changes.watch",
      serviceAccountId: "service_account_1",
      resourceId: resourceId1,
      url: "https://example1.com",
    });
    await channel.store(channelId2, {
      type: "files.watch",
      serviceAccountId: "service_account_2",
      fileId: "file_1",
      resourceId: resourceId2,
      url: "https://example2.com",
    });

    const result = [];
    await channel.iterate((data) => {
      result.push(data);
    });

    result.sort((a, b) => a.serviceAccountId.localeCompare(b.serviceAccountId));
    const expected = [
      {
        type: "changes.watch",
        serviceAccountId: "service_account_1",
        resourceId: resourceId1,
        url: "https://example1.com",
      },
      {
        type: "files.watch",
        serviceAccountId: "service_account_2",
        fileId: "file_1",
        resourceId: resourceId2,
        url: "https://example2.com",
      },
    ];
    expected.sort((a, b) =>
      a.serviceAccountId.localeCompare(b.serviceAccountId)
    );
    expect(result).toEqual(expected);
  });

  it("propagates client promise failures", async function () {
    const error = new Error("boom");
    spyOn(client, "hSet").and.callFake(() => Promise.reject(error));

    await expectAsync(
      channel.store("channel_failure", {
        type: "changes.watch",
        serviceAccountId: "service_account_1",
        resourceId: "resource_failure",
        url: "https://example.com",
      })
    ).toBeRejectedWith(error);
    expect(client.hSet).toHaveBeenCalled();
  });
});
