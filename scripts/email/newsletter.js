var send = require("helper/email").send;
var letter = process.argv[2];
var fs = require("fs");
var client = require("models/client");
var async = require("async");

if (!letter) {
  console.log("Select an email to send:");
  fs.readdirSync(__dirname + "/../../app/helper/email/newsletters").forEach(
    function (letter) {
      console.log("node scripts/email/newsletter", letter);
    }
  );
  process.exit();
}

main(letter, function (err) {
  if (err) throw err;

  console.log("All emails delivered!");
  process.exit();
});

function main(letter, callback) {
  var emailPath = __dirname + "/../../app/helper/email/newsletters/" + letter;

  if (!fs.statSync(emailPath).isFile())
    return callback(new Error("Not a file"));

  getAllSubscribers(function (err, emails) {
    if (err) return callback(err);

    console.log(
      "Sending " + letter + " out to " + emails.length + " subscribers"
    );

    async.filter(emails, alreadySent, function (err, emails) {
      if (err) return callback(err);

      // When we want to preview a newsletter before it goes out
      if (process.env.PREVIEW_NEWSLETTER === "true") {
        emails = ["example@example.com"];
      }

      async.eachSeries(
        emails,
        function (email, next) {
          console.log("Sending", email);

          send({ email: email }, emailPath, email, function (err) {
            if (err) return next(err);

            console.log(". Email sent to", email);
            client
              .sAdd("newsletter:letter:" + letter, email)
              .then(function () {
                next();
              })
              .catch(next);
          });
        },
        callback
      );
    });
  });
}

function getAllSubscribers(callback) {
  client
    .sMembers("newsletter:list")
    .then(function (emails) {
      callback(null, emails);
    })
    .catch(callback);
}

function alreadySent(email, done) {
  client
    .sIsMember("newsletter:letter:" + letter, email)
    .then(function (member) {
      if (member) console.log("Email already sent to", email);
      done(null, !member);
    })
    .catch(done);
}
