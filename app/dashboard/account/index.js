var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var Express = require("express");
var Account = new Express.Router();
var logout = require("./util/logout");
const prettyPrice = require("helper/prettyPrice");
const { LRUCache } = require("lru-cache");
const Email = require("helper/email");
const { errorHandler } = require("dashboard/util/message");

const BREADCRUMBS = {
  "pay-subscription": "Subscription overdue",
};

Account.use(function (req, res, next) {
  res.locals.breadcrumbs.add("Account", "/sites/account");
  res.locals.account = true;
  next();
});

// A Stripe round trip takes ~200ms. The account page shows a credit from a
// cache; the subscription pages always ask Stripe, and refresh the cache.
const balances = new LRUCache({ max: 1000, ttl: 10 * 60 * 1000 });

function describeBalance(balance) {
  if (balance < 0)
    return { credit: true, amount: prettyPrice(Math.abs(balance)) };
  if (balance > 0) return { debit: true, amount: prettyPrice(balance) };
}

function loadSubscriptionBalance({ cached } = {}) {
  return function (req, res, next) {
    const customerID = req.user.subscription && req.user.subscription.customer;
    if (!customerID) return next();

    if (cached && balances.has(customerID)) {
      res.locals.balance = describeBalance(balances.get(customerID));
      return next();
    }

    stripe.customers.retrieve(customerID, function (err, customer) {
      // If we're offline or Stripe is down don't take the settings
      // page
      if (err && err.type === "StripeConnectionError") return next();

      if (err) return next(err);

      balances.set(customerID, customer.balance);
      res.locals.balance = describeBalance(customer.balance);
      next();
    });
  };
}

// Only the pages that show the balance ask Stripe for it, not every
// subscription subpage (payment methods, cancel, ...)
Account.get(
  ["/subscription", "/subscription/billing-interval", "/pay-subscription"],
  loadSubscriptionBalance()
);

Account.route("/").get(
  loadSubscriptionBalance({ cached: true }),
  function (req, res) {
    res.locals.title = "Account";
    res.locals.isAccountView = true;
    res.render("dashboard/account/index", { monthly: req.user.isMonthly });
  }
);

Account.use("/:section", function (req, res, next) {
  var uppercaseName = req.params.section;

  if (BREADCRUMBS[req.params.section]) {
    uppercaseName = BREADCRUMBS[req.params.section];
  } else {
    uppercaseName = uppercaseName[0].toUpperCase() + uppercaseName.slice(1);
    uppercaseName = uppercaseName.split("-").join(" ");
  }

  res.locals.breadcrumbs.add(uppercaseName, req.params.section);
  next();
});

Account.use("/:section/:subsection", function (req, res, next) {
  var uppercaseName = req.params.subsection;

  if (BREADCRUMBS[req.params.subsection]) {
    uppercaseName = BREADCRUMBS[req.params.subsection];
  } else {
    uppercaseName = uppercaseName[0].toUpperCase() + uppercaseName.slice(1);
    uppercaseName = uppercaseName.split("-").join(" ");
  }

  res.locals.breadcrumbs.add(uppercaseName, req.params.subsection);
  next();
});

Account.use("/password", require("./password"));
Account.use("/email", require("./email"));
Account.use("/create-site", require("./create-site"));
Account.use("/subscription", require("./subscription"));
Account.use("/pay-subscription", require("./pay-subscription"));

const { updateSubscription } = require("dashboard/webhooks/paypal_webhook");

Account.get("/delete-blog-paypal", function (req, res) {
  res.locals.paypal_client_id = config.paypal.client_id;
  res.locals.new_quantity = req.user.blogs.length;
  res.render("dashboard/account/delete-blog-paypal");
});

Account.get("/delete-blog-paypal/update", async (req, res, next) => {
  try {
    // fetch the latest subscription from PayPal
    if (!req.user.paypal.id) return next();

    await updateSubscription(req.user.paypal.id);
    Email.SUBSCRIPTION_DECREASE(req.user.uid);

    res.message("/sites", "Reduced your PayPal subscription");
  } catch (err) {
    next(err);
  }
});

Account.post("/log-out", logout, function (req, res) {
  res.redirect("/log-in?out=true");
});

Account.use(function (err, req, res, next) {
  if (req.method === "GET") {
    console.log(err, err.trace);
    require("dashboard/util/render-error")(err, req, res);
  } else if (req.method === "POST") {
    return errorHandler(err, req, res, next);
  } else {
    next(err);
  }
});

// require("./pay-subscription")(server);

module.exports = Account;
