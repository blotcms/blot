const config = require("config");
const User = require("models/user");

async function main(uid, paypalId) {
  if (!uid) {
    throw new Error("No user passed");
  }

  if (!paypalId) {
    throw new Error("No paypalId passed");
  }

  const response = await fetch(
    `${config.paypal.api_base}/v1/billing/subscriptions/${paypalId}`,
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

  const paypal = await response.json();

  if (!paypal || !paypal.id) {
    throw new Error("No subscription found");
  }

  console.log("storing", paypal);
  await User.set(uid, { paypal: paypal });
}

const get = require("../get/user");

(async () => {
  const { user } = await get(process.argv[2]);
  if (!user) throw new Error("No user found");
  await main(user.uid, process.argv[3]);
  console.log(
    "Stored paypal subscription",
    process.argv[3],
    "against",
    user.email
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
