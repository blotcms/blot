async function main() {
  var client = require("models/client");

  const subscribers = await client.sMembers("newsletter:list");

  return { newsletter_subscribers: subscribers.length };
}

module.exports = main;

if (require.main === module) require("./cli")(main);
