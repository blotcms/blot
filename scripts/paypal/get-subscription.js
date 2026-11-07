const config = require("config");
const get = require("../get/user");
const fetch = require("node-fetch");
const getConfirmation = require("../util/getConfirmation");
const colors = require("colors/safe");
const User = require("models/user");
const each = require("../each/user");
const { promisify } = require("util");

// Resolves null when the subscription was updated, and undefined when the
// user has no matching subscription (the callback version passed the same
// values to its callback).
async function main(user) {
  if (!user.paypal || !user.paypal.id) {
    console.log(
      colors.dim(
        "User:",
        user.uid,
        user.email,
        "does not have a PayPal subscription"
      )
    );
    return;
  }

  const response = await fetch(
    `${config.paypal.api_base}/v1/billing/subscriptions/${user.paypal.id}`,
    {
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": "en_US",
        Authorization: `Basic ${Buffer.from(
          `${config.paypal.client_id}:${config.paypal.secret}`
        ).toString("base64")}`,
      },
    }
  );

  let paypal;

  try {
    paypal = await response.json();
  } catch (e) {
    console.log(e);
  }

  if (!paypal || !paypal.id || paypal.id !== user.paypal.id) {
    console.log(
      colors.red(
        "User:",
        user.uid,
        user.email,
        "does not have a matching PayPal subscription anymore"
      )
    );
    return;
  }

  await User.set(user.uid, { paypal });
  console.log(
    colors.green(
      "User:",
      user.uid,
      user.email,
      "subscription updated from PayPal"
    )
  );
  return null;
}

module.exports = main;

if (require.main === module) {
  if (process.argv[2]) {
    (async () => {
      const user = await promisify(get)(process.argv[2]);
      console.log(await main(user));
    })().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    (async () => {
      const ok = await getConfirmation(
        "Fetch latest subscription information from PayPal for all users? (y/N)"
      );
      if (!ok) return process.exit();
      await promisify(each)((user, next) => {
        main(user).then(
          () => next(),
          (err) => next(err)
        );
      });
      console.log("Done!");
      process.exit();
    })().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}
