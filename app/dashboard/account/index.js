var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var Express = require("express");
var Account = new Express.Router();
var logout = require("./util/logout");
const prettyPrice = require("helper/prettyPrice");
const Email = require("helper/email");
const { errorHandler } = require("dashboard/util/message");

const BREADCRUMBS = {
  "pay-subscription": "Subscription overdue",
};

Account.use(function (req, res, next) {
  res.locals.breadcrumbs.add("Account", "/account");
  res.locals.account = true;
  next();
});

Account.use(["/subscription", "/pay-subscription"], function (req, res, next) {
  if (!req.user.subscription || !req.user.subscription.customer) return next();

  stripe.customers.retrieve(
    req.user.subscription.customer,
    function (err, customer) {
      // If we're offline or Stripe is down don't take the settings
      // page
      if (err && err.type === "StripeConnectionError") return next();

      if (err) return next(err);

      if (customer.balance !== 0 && Math.sign(customer.balance) === -1) {
        res.locals.balance = {
          credit: true,
          amount: prettyPrice(Math.abs(customer.balance)),
        };
      } else if (customer.balance !== 0 && Math.sign(customer.balance) === 1) {
        res.locals.balance = {
          debit: true,
          amount: prettyPrice(Math.abs(customer.balance)),
        };
      }

      next();
    }
  );
});

Account.route("/").get(function (req, res) {
  res.redirect("/sites");
});

Account.use("/:section", function (req, res, next) {
  var uppercaseName = req.params.section;

  if (BREADCRUMBS[req.params.section]) {
    uppercaseName = BREADCRUMBS[req.params.section]
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
    uppercaseName = BREADCRUMBS[req.params.subsection]
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
  // fetch the latest subscription from PayPal
  if (!req.user.paypal.id) return next();

  await updateSubscription(req.user.paypal.id);
  Email.SUBSCRIPTION_DECREASE(req.user.uid);

  res.message("/sites", "Reduced your PayPal subscription");
});

Account.post("/log-out", logout, function (req, res) {
  res.redirect("/log-in?out=true");
});

Account.use(function (err, req, res, next) {
  if (req.method === "GET") {
    console.log(err, err.trace);
    res.status(400);
    res.render("dashboard/error", { error: err });
  } else if (req.method === "POST") {
    return errorHandler(err, req, res, next);
  } else {
    next(err);
  }
});

// require("./pay-subscription")(server);

module.exports = Account;
