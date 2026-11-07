var Blog = require("models/blog");
var User = require("models/user");
var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var email = "dmerfield" + Date.now() + "@gmail.com";
var { v4: uuid } = require("uuid");
var debug = require("debug")("scripts:user:overdue-subscription");
var access = require("../blog/access");
var fetchSubscription = require("./fetch-subscription-from-stripe");

var customer = {
  card: "tok_mastercard",
  email: email,
  plan: config.stripe.plan,
  trial_end: Math.round(Date.now() / 1000) + 1000,
  description: "Blot subscription",
};

var password = "x";

var blog = {
  handle: "overdue" + uuid().split("-").join(""),
};

if (require.main === module)
  main().then(
    async function (result) {
      if (!result.invoices) throw new Error("No invoice returned");

      var url = await access(result.email);
      console.log(
        "Unpaid invoice found for " +
          result.email +
          "! Please log in and pay it:"
      );
      console.log(url);
      console.log("Use password:", password);
      process.exit();
    },
    function (err) {
      console.log(err);
      throw err;
    }
  );

// Polls Stripe until the customer has an unpaid invoice, 5s apart
async function waitForUnpaidInvoices(customerID) {
  for (;;) {
    var res = await stripe.invoices.list({ customer: customerID });

    var invoices = res.data.filter(function (invoice) {
      return !invoice.paid;
    });

    if (invoices.length) return invoices;

    console.log("No unpaid invoices yet, waiting 5s and trying again...");

    await new Promise(function (resolve) {
      setTimeout(resolve, 5000);
    });
  }
}

async function main() {
  var stripeCustomer = await stripe.customers.create(customer);

  debug("Created stripe customer");

  console.log(password);
  var passwordHash = await User.hashPassword(password);
  console.log(passwordHash);

  var user = await User.create(
    email,
    passwordHash,
    stripeCustomer.subscription,
    {}
  );

  debug("Created user on Blot", blog, user.uid);

  var createdBlog = await Blog.create(user.uid, blog);

  debug("Created blog", createdBlog);

  await stripe.customers.update(stripeCustomer.id, {
    card: "tok_chargeCustomerFail",
  });

  debug("Updated stripe subscription to bad card");

  await stripe.customers.updateSubscription(
    stripeCustomer.id,
    stripeCustomer.subscription.id,
    {
      trial_end: Math.round(Date.now() / 1000) + 3,
      prorate: false,
    }
  );

  debug("Ended stripe subscription trial");

  var invoices = await waitForUnpaidInvoices(stripeCustomer.id);

  try {
    await Promise.all(
      invoices.map(function (invoice) {
        if (invoice.paid) return;
        return stripe.invoices.pay(invoice.id);
      })
    );
  } catch {
    // async.each's final callback ignored errors and carried on, so do the same
  }

  await fetchSubscription(user);

  return { email: email, invoices: invoices };
}
