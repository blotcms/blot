const readline = require("readline");
const moment = require("moment");

const get = require("../get/entry");
const Entry = require("models/entry");
const getConfirmation = require("../util/getConfirmation");

if (!process.argv[2]) {
  console.log(
    "Please pass a URL to a blog post or source file as the first and only argument to this script. Blot will set the entry's dateStamp to the provided date."
  );
  process.exit(1);
}

const url = process.argv[2];

function promptForDate(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

get(url, async function (err, user, blog, entry) {
  if (err) {
    console.error("Error retrieving entry:", err.message);
    process.exit(1);
  }

  if (!entry) {
    console.error("No entry found at the provided URL.");
    process.exit(1);
  }

  console.log(
    "Current dateStamp:",
    entry.dateStamp ?? "not set",
    entry.dateStamp ? `(${new Date(entry.dateStamp).toUTCString()})` : ""
  );

  const timestamps = [];

  if (typeof entry.created === "number") timestamps.push(entry.created);
  if (typeof entry.updated === "number") timestamps.push(entry.updated);

  if (timestamps.length) {
    const earliest = Math.min(...timestamps);
    const sourceTimeLabel =
      earliest === entry.created ? "Creation time" : "Last modified time";

    console.log(
      `Earliest source file timestamp (${sourceTimeLabel}):`,
      earliest,
      `(${new Date(earliest).toUTCString()})`
    );
  }

  console.log(
    "Example input: 2024-01-31 15:04 (YYYY-MM-DD HH:mm).",
    "Other formats like 'Jan 31 2024' also work."
  );

  const input = await promptForDate(
    "Enter a new date (e.g. 2024-01-31 15:04): "
  );

  if (!input) {
    console.error("No date provided. Aborting.");
    process.exit(1);
  }

  const parsed = moment.utc(input);

  if (!parsed.isValid()) {
    console.error(
      "Invalid date. Please provide a recognizable date string, such as '2024-01-31', 'Jan 31 2024', or '2024-01-31 15:04'."
    );
    process.exit(1);
  }

  const newDateStamp = parsed.valueOf();

  console.log(
    "Parsed dateStamp:",
    newDateStamp,
    `(${new Date(newDateStamp).toUTCString()})`
  );

  const confirmed = await getConfirmation(
    `Change dateStamp from ${entry.dateStamp} to ${newDateStamp}?`
  );

  if (!confirmed) {
    console.log("Aborted. No changes made.");
    process.exit(0);
  }

  Entry.set(blog.id, entry.path, { dateStamp: newDateStamp }, function (err) {
    if (err) {
      console.error("Failed to update entry:", err.message);
      process.exit(1);
    }

    console.log("Updated entry:", entry.path);
    process.exit(0);
  });
});
