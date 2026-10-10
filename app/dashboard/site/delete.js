const express = require("express");
const Delete = new express.Router();
const pretty = require("helper/prettyPrice");
const Email = require("helper/email");

const checkPassword = require("dashboard/account/util/checkPassword");

const User = require("models/user");
const Blog = require("models/blog");

const config = require("config");
const stripe = require("stripe")(config.stripe.secret);

Delete.route("/")

  // Verify the blog to be closed is owned
  // by the current user and load it into locals.
  // Work out how much we need to change the subscription
  // by after the blog has been deleted.
  .all(calculateSubscriptionChange)

  .get(function (req, res) {
    res.locals.title = "Delete " + req.blog.pretty.label;
    res.locals.breadcrumbs.add("Delete", "delete");
    res.render("dashboard/site/delete");
  })

  // Save any changes to the user's subscription
  // then remove the blogID from the list of blogs
  // owned by the user.
  // Finally delete the blog's generated assets (cached images,
  // avatars, ...) through storage/assets. Also delete
  // the contents blog's folder on the server.
  // Delete the credentials used to sync the blog's folder
  .post(
    checkPassword,
    function (req, res, next) {
      Blog.remove(req.blog.id, next);
    },
    calculateSubscriptionChange,
    decreaseSubscription,
    function (req, res) {
      // In order to decrease the quantity of a PayPal
      // subscription we need to redirect the user to
      // PayPal to confirm the change.
      if (req.user.paypal.status && req.user.blogs.length > 0) {
        return res.message(
          "/account/delete-blog-paypal",
          "Deleted " + req.blog.title
        );
      }
      res.message("/sites", "Deleted " + req.blog.title);
    }
  );

function calculateSubscriptionChange(req, res, next) {
  var subscription = req.user.subscription;

  // The user does not have an active subscription
  // so proceed to the next middleware
  if (!subscription || !subscription.status || subscription.status !== "active")
    return next();

  var currentQuantity = req.user.subscription.quantity;
  var newQuantity = req.user.blogs.length - 1;

  // Quantity cannot go below 1
  // You must pay for at least one blog to keep an account open
  // We only decrease the quantity on the Stripe plan if you are
  // paying for all of your blogs.
  if (newQuantity < 1) newQuantity = 1;

  // You can't increase your bill by deleting a blog
  // Some early users have free blogs for various
  // reasons. Handle this case here.
  if (newQuantity >= currentQuantity) return next();

  res.locals.reduction = pretty(
    (currentQuantity - newQuantity) * req.user.subscription.plan.amount
  );
  req.newQuantity = newQuantity;

  return next();
}

function decreaseSubscription(req, res, next) {
  var subscription = req.user.subscription;
  var quantity = req.newQuantity;

  if (!quantity || !subscription) return next();

  stripe.customers.updateSubscription(
    subscription.customer,
    subscription.id,
    { quantity: quantity, prorate: false },
    function (err, subscription) {
      if (err) return next(err);

      if (!subscription) return next(new Error("No subscription"));

      User.set(req.user.uid, { subscription: subscription }, function (err) {
        if (err) return next(err);

        Email.SUBSCRIPTION_DECREASE(req.user.uid);
        next();
      });
    }
  );
}

module.exports = Delete;
