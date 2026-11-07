const express = require("express");
const Delete = new express.Router();
const pretty = require("helper/prettyPrice");
const Email = require("helper/email");

const checkPassword = require("dashboard/account/util/checkPassword");

const User = require("models/user");
const Blog = require("models/blog");
const Entries = require("models/entries");
const Template = require("models/template");
const punycode = require("helper/punycode");

const config = require("config");
const stripe = require("stripe")(config.stripe.secret);

// Save any changes to the user's subscription
// then remove the blogID from the list of blogs
// owned by the user.
// Finally delete the blog's generated assets (cached images,
// avatars, ...) through storage/assets. Also delete
// the contents blog's folder on the server.
// Delete the credentials used to sync the blog's folder
const deleteSite = [
  checkPassword,
  async function (req, res, next) {
    try {
      await Blog.remove(req.blog.id);
    } catch (err) {
      return next(err);
    }

    next();
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
  },
];

Delete.route("/")

  // Verify the blog to be closed is owned
  // by the current user and load it into locals.
  // Work out how much we need to change the subscription
  // by after the blog has been deleted.
  .all(calculateSubscriptionChange)

  // The first step: delete, or don't, with what it means
  .get(function (req, res) {
    res.locals.title = "Delete " + req.blog.pretty.label;
    res.locals.breadcrumbs.add("Delete", "delete");
    res.render("dashboard/site/delete");
  })

  // Deleting was a POST to /delete before the confirm step; keep it working
  .post(deleteSite);

// The second step: what will go, an export to download first, and the
// password. Its form posts back here, so a wrong password shows here too.
Delete.post("/confirm", calculateSubscriptionChange, deleteSite);

Delete.get(
  "/confirm",
  calculateSubscriptionChange,
  async function (req, res, next) {
    try {
      res.locals.deleteSummary = await summarise(req.blog);
    } catch (err) {
      return next(err);
    }

    res.locals.title = "Delete " + req.blog.pretty.label;
    res.locals.breadcrumbs.add("Delete", "delete");
    res.locals.breadcrumbs.add("Confirm", "confirm");
    res.render("dashboard/site/delete-confirm");
  }
);

function count(n, one, many) {
  return n.toLocaleString("en-US") + " " + (n === 1 ? one : many);
}

// One line per thing the delete removes or stops: posts and other entries,
// the blog's own templates, and the addresses which stop working
async function summarise(blog) {
  const [posts, pages, drafts, scheduled, templates] = await Promise.all([
    Entries.getListTotal(blog.id, "entries"),
    Entries.getListTotal(blog.id, "pages"),
    Entries.getListTotal(blog.id, "drafts"),
    Entries.getListTotal(blog.id, "scheduled"),
    Template.getTemplateList(blog.id),
  ]);
  const own = Object.values(templates || {}).filter(
    (template) => template && template.owner === blog.id
  ).length;

  const lines = [count(posts, "post", "posts")];
  if (pages) lines.push(count(pages, "page", "pages"));
  if (drafts) lines.push(count(drafts, "draft", "drafts"));
  if (scheduled)
    lines.push(count(scheduled, "scheduled post", "scheduled posts"));
  if (own)
    lines.push(count(own, "template", "templates") + " you made or changed");
  lines.push("Its settings, redirects and connection to your folder");
  if (blog.domain)
    lines.push(punycode.toUnicode(blog.domain) + " will stop working");
  lines.push(blog.handle + "." + config.host + " will stop working");

  return lines.map((text) => ({ text }));
}

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

async function decreaseSubscription(req, res, next) {
  var subscription = req.user.subscription;
  var quantity = req.newQuantity;

  if (!quantity || !subscription) return next();

  try {
    var updated = await new Promise(function (resolve, reject) {
      stripe.customers.updateSubscription(
        subscription.customer,
        subscription.id,
        { quantity: quantity, prorate: false },
        function (err, updated) {
          if (err) return reject(err);
          resolve(updated);
        }
      );
    });

    if (!updated) throw new Error("No subscription");

    await new Promise(function (resolve, reject) {
      User.set(req.user.uid, { subscription: updated }, function (err) {
        if (err) return reject(err);
        resolve();
      });
    });
  } catch (err) {
    return next(err);
  }

  Email.SUBSCRIPTION_DECREASE(req.user.uid);
  next();
}

module.exports = Delete;
