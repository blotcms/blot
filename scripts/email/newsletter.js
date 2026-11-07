var send = require("helper/email").send;
var letter = process.argv[2];
var fs = require("fs");
var client = require("models/client");

if (!letter) {
  console.log("Select an email to send:");
  fs.readdirSync(__dirname + "/../../app/helper/email/newsletters").forEach(
    function (letter) {
      console.log("node scripts/email/newsletter", letter);
    }
  );
  process.exit();
}

main(letter).then(
  function () {
    console.log("All emails delivered!");
    process.exit();
  },
  function (err) {
    console.error(err);
    process.exit(1);
  }
);

async function main(letter) {
  var emailPath = __dirname + "/../../app/helper/email/newsletters/" + letter;

  if (!fs.statSync(emailPath).isFile()) throw new Error("Not a file");

  var emails = await getAllSubscribers();

  console.log(
    "Sending " + letter + " out to " + emails.length + " subscribers"
  );

  // Checked in parallel, and the order of the list is kept
  var unsent = await Promise.all(emails.map((email) => alreadySent(email)));
  emails = emails.filter((email, i) => unsent[i]);

  // When we want to preview a newsletter before it goes out
  if (process.env.PREVIEW_NEWSLETTER === "true") {
    emails = ["example@example.com"];
  }

  for (const email of emails) {
    console.log("Sending", email);

    await send({ email: email }, emailPath, email);

    console.log(". Email sent to", email);
    await client.sAdd("newsletter:letter:" + letter, email);
  }
}

function getAllSubscribers() {
  return client.sMembers("newsletter:list");
}

async function alreadySent(email) {
  var member = await client.sIsMember("newsletter:letter:" + letter, email);
  if (member) console.log("Email already sent to", email);
  return !member;
}
