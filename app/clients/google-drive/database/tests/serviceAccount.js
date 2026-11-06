describe("serviceAccount module", function () {
  const serviceAccount = require("clients/google-drive/database/serviceAccount");
  const client = require("models/client");
  const prefix = require("clients/google-drive/database/prefix");

  // Before each test, clear all Redis data with the matching prefix
  afterEach(async function () {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length) {
      await client.del(keys);
    }
  });

  it("can store and retrieve a service account", async function () {
    const serviceAccountId = "service_account_1";
    const serviceAccountData = {
      email: "service_account_1@example.com",
      privateKey: "PRIVATE_KEY",
      date: 123,
      nest: { apple: "orange" },
      time: null,
      yes: false,
    };

    // Store the service account
    await serviceAccount.store(serviceAccountId, serviceAccountData);

    // Retrieve the service account
    const retrievedData = await serviceAccount.get(serviceAccountId);
    expect(retrievedData).toEqual(serviceAccountData);
  });

  it("can list all stored service accounts", async function () {
    const serviceAccountId1 = "service_account_1";
    const serviceAccountId2 = "service_account_2";

    await serviceAccount.store(serviceAccountId1, {
      email: "service_account_1@example.com",
      privateKey: "PRIVATE_KEY_1",
    });
    await serviceAccount.store(serviceAccountId2, {
      email: "service_account_2@example.com",
      privateKey: "PRIVATE_KEY_2",
    });

    const serviceAccounts = await serviceAccount.list();
    expect(serviceAccounts.sort()).toEqual(
      [serviceAccountId1, serviceAccountId2].sort()
    );
  });

  it("can delete a service account", async function () {
    const serviceAccountId = "service_account_1";
    const serviceAccountData = {
      email: "service_account_1@example.com",
      privateKey: "PRIVATE_KEY",
    };

    await serviceAccount.store(serviceAccountId, serviceAccountData);

    // Ensure the service account exists
    const retrievedData = await serviceAccount.get(serviceAccountId);
    expect(retrievedData).toEqual(serviceAccountData);

    // Delete the service account
    await serviceAccount.delete(serviceAccountId);

    // Ensure the service account is removed
    const deletedData = await serviceAccount.get(serviceAccountId);
    expect(deletedData).toEqual(null); // Redis returns an empty object for non-existent hashes

    // Ensure the service account is no longer in the global list
    const serviceAccounts = await serviceAccount.list();
    expect(serviceAccounts).not.toContain(serviceAccountId);
  });

  it("gracefully handles deletion of a non-existent service account", async function () {
    const nonExistentServiceAccountId = "non_existent_service_account";

    // Attempt to delete a non-existent service account
    await expectAsync(
      serviceAccount.delete(nonExistentServiceAccountId)
    ).toBeResolved();

    // Ensure the non-existent service account is not listed globally
    const serviceAccounts = await serviceAccount.list();
    expect(serviceAccounts).not.toContain(nonExistentServiceAccountId);
  });

  it("propagates client promise failures", async function () {
    const error = new Error("boom");
    spyOn(client, "hSet").and.callFake(() => Promise.reject(error));

    await expectAsync(
      serviceAccount.store("service_account_failure", {
        email: "service_account_failure@example.com",
      })
    ).toBeRejectedWith(error);
    expect(client.hSet).toHaveBeenCalled();
  });
});
