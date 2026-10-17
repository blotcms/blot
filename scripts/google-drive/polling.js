const changesList = require("./query-changes-list");
const filesList = require("./query-files-list");
const driveActivity = require("./query-drive-activity");

const changesWatch = require('./establish-test-channel-changes.watch.js');

const config = require('config');
const { drive: createDrive, auth: googleAuth } = require('@googleapis/drive');
const { driveactivity: createDriveActivity } = require('@googleapis/driveactivity');
const database = require('clients/google-drive/database');
const get = require("../get/blog");
const clfdate = require("helper/clfdate");

get(process.argv[2], async function (err, user, blog) {
  if (err) throw err;

  const account = await database.getAccount(blog.id);
  const serviceAccount = await database.serviceAccount.get(account.client_id);
  const email = serviceAccount.user.emailAddress;
  const credentials = config.google_drive.service_accounts.find(
    (sa) => sa.client_email === email
  );

  const drive = createDrive({
    version: "v3",
    auth: new googleAuth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive"],
    }),
  });

  // list all drives
  const res = await drive.drives.list();
    console.log(res.data.drives);

  const driveactivity = createDriveActivity({
    version: "v2",
    auth: new googleAuth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive.activity.readonly"],
    }),
  });

  setInterval(async () => {
    try {
      await changesList(drive);
    } catch (e) {
      console.error(e);
    }

    try {
      await filesList(drive);
    } catch (e) {
      console.error(e);
    }

    try {
      await driveActivity(driveactivity, account.folderId);
    } catch (e) {
      console.error(e);
    }
  }, 5000);


    const express = require("express");
    const app = express();

    app.post("/clients/google-drive/api-test", (req, res) => {

        // Respond to the initial verification request but don't log it
        if (req.header('x-goog-resource-state') === 'sync') {
            return res.send('OK!');
        }

        console.log(clfdate(), padStringToLength(req.header("x-goog-channel-token"), 'driveactivity.query'.length));
        res.send("OK!");
    });

    const padStringToLength = (str, len) => {
        while (str.length < len) {
            str += " ";
        }
        return str;
    };

    app.listen(8865);

    const changesWatchResourceId = await changesWatch.setup(drive);

    const teardown = async () => {
        console.log("Caught interrupt signal, tearing down webhooks...");
        await changesWatch.teardown(drive, changesWatchResourceId);
        process.exit();
    };

    // Handle graceful shutdown
    // Handle termination signal
    process.on("SIGINT", teardown);
    process.on("SIGTERM", teardown);    
});
