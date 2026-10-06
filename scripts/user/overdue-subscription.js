var Blog = require("models/blog");
var User = require("models/user");
var config = require("config");
var async = require("async");
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
  description: "Blot subscription"
};

var password = "x";

var blog = {
  handle: "overdue" + uuid().split("-").join("")
};

if (require.main === module)
  main(function (err, email, invoice) {
    if (err) {
      console.log(err);
      throw err;
    }

    if (!invoice) throw new Error("No invoice returned");

    access(email, function (err, url) {
      if (err) throw err;
      console.log(
        "Unpaid invoice found for " + email + "! Please log in and pay it:"
      );
      console.log(url);
      console.log("Use password:", password);
      process.exit();
    });
  });

function main (callback) {
  stripe.customers.create(customer, function (err, customer) {
    if (err) return callback(err);

    debug("Created stripe customer");

    console.log(password);
    User.hashPassword(password, function (err, passwordHash) {
      if (err) return callback(err);
      console.log(passwordHash);

      User.create(
        email,
        passwordHash,
        customer.subscription,
        {},
        function (err, user) {
          if (err) return callback(err);

          debug("Created user on Blot", blog, user.uid);

          Blog.create(user.uid, blog, function (err, blog) {
            if (err) return callback(err);

            debug("Created blog", blog);

            stripe.customers.update(
              customer.id,
              {
                card: "tok_chargeCustomerFail"
              },
              function (err) {
                if (err) return callback(err);

                debug("Updated stripe subscription to bad card");

                stripe.customers.updateSubscription(
                  customer.id,
                  customer.subscription.id,
                  {
                    trial_end: Math.round(Date.now() / 1000) + 3,
                    prorate: false
                  },
                  function (err, subscription) {
                    if (err) return callback(err);

                    debug("Ended stripe subscription trial");

                    stripe.invoices.list(
                      { customer: customer.id },
                      function onList (err, res) {
                        if (err) return callback(err);

                        var invoices = res.data.filter(function (invoice) {
                          return !invoice.paid;
                        });

                        if (!invoices.length) {
                          console.log(
                            "No unpaid invoices yet, waiting 5s and trying again..."
                          );
                          return setTimeout(function () {
                            stripe.invoices.list(
                              { customer: customer.id },
                              onList
                            );
                          }, 5000);
                        }

                        async.each(
                          invoices,
                          function (invoice, nextInvoice) {
                            if (invoice.paid) return nextInvoice();
                            stripe.invoices.pay(invoice.id, nextInvoice);
                          },
                          function () {
                            fetchSubscription(user, function (err) {
                              if (err) return callback(err);
                              callback(null, email, invoices);
                            });
                          }
                        );
                      }
                    );
                  }
                );
              }
            );
          });
        }
      );
    });
  });
}
