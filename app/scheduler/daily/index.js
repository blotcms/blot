var Email = require("helper/email");
var clfdate = require("helper/clfdate");

async function main() {
  var view = {};

  view.date = require("moment")().format("LL");

  const log = (msg) => async () => {
    console.log(clfdate(), "Daily update:", msg);
    return {};
  };

  const steps = [
    log("Starting daily update"),
    log("Checking number of users"),
    require("./revenue"),
    log("Checking clients used by current users"),
    require("./clients"),
    log("Checking for blogs with new posts"),
    require("./new-posts"),
    log("Checking number of newsletter subscribers"),
    require("./newsletter-subscribers"),
    log("Checking for new customers"),
    require("./new-customers"),
    log("Checking render time percentiles"),
    require("./render-time"),
    log("Checking the Redis server"),
    require("./redis-server"),
    log("Checking the storage bucket"),
    require("./storage"),
    log("Checking the iCloud macserver"),
    require("./macserver"),
    log("Finished daily update"),
  ];

  for (const step of steps) {
    // A step that fails leaves its lines out of the email; the rest still go
    try {
      const res = await step();
      if (res) for (var i in res) view[i] = res[i];
    } catch (err) {
      // carry on with the next step
    }
  }

  await Email.DAILY_UPDATE("", view);
}

if (require.main === module) require("./cli")(main);

module.exports = main;
