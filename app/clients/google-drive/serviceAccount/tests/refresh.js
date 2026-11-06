const config = require("config");
const { refreshServiceAccount } = require("../fetchStorageInfo");
const intercept = require("./util/intercept");

xdescribe("refreshServiceAccount", function () {
  beforeEach(function () {
    // Intercept Google Drive API for this test
    intercept(
      "refresh-service-account", // Spec name
      "about-get" // Unique identifier for the request
    );
  });

  it(`should refresh service account and store its quota`, async function () {
    const database = require("../../database/serviceAccount");
    spyOn(database, "store").and.callThrough();

    const credentials = config.google_drive.service_accounts[0];

    await refreshServiceAccount(credentials);

    expect(database.store).toHaveBeenCalledWith(
      credentials.client_id,
      jasmine.objectContaining({
        quotaFree: jasmine.any(String),
        quotaUsage: jasmine.any(String),
        quotaLimit: jasmine.any(String),
      })
    );
  });
});
