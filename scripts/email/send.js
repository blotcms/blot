var send = require("helper/email").send;
var getConfirmation = require("../util/getConfirmation");
var fs = require("fs-extra");
var colors = require("colors/safe");

async function sendToUsers(emailFile, users) {
  if (!users.length)
    throw new Error("No users in list of users to send email to.");

  var unique = {};

  users = users.filter(function (user) {
    if (unique[user.email]) return false;
    unique[user.email] = true;
    return true;
  });

  console.log(
    colors.dim("-------------------\n") +
      fs.readFileSync(emailFile, "utf-8") +
      colors.dim("\n-------------------\n")
  );

  const ok = await getConfirmation(
    "Send email to " + colors.green(users.length + " users") + "? (y/n)"
  );

  if (!ok) {
    console.log("Emails were not sent.");
    return process.exit();
  }

  for (const user of users) {
    try {
      await new Promise(function (resolve, reject) {
        send(user, emailFile, user.email, function (err) {
          if (err) return reject(err);
          resolve();
        });
      });
    } catch (err) {
      console.log("Error sending message to", user.email);
    }
  }

  console.log("Emails sent");
}

// Keeps the callback API. Nothing in the repository calls this module.
module.exports = function (emailFile, users, callback) {
  sendToUsers(emailFile, users).then(
    function () {
      callback();
    },
    function (err) {
      callback(err);
    }
  );
};
