var Express = require("express");
var CreateBlog = new Express.Router();
var Blog = require("models/blog");
var _ = require("lodash");
var prettyPrice = require("helper/prettyPrice");
var config = require("config");
// The SSL-cert warmup below fetches the new blog's URL, which is a user-set
// custom domain when one is configured; route it through the airlock proxy.
var fetch = require("helper/airlock").fetch;
var stripe = require("stripe")(config.stripe.secret);
var User = require("models/user");
var Email = require("helper/email");
var BAD_CHARGE = "Could not charge your card.";
var ERR = "Could not change your subscription.";
var updatePayPalSubscription =
  require("dashboard/webhooks/paypal_webhook").updateSubscription;

const randomChars = require("./util/randomChars");
const handleFromTitle = require("./util/handleFromTitle");

CreateBlog.use(function (req, res, next) {
  res.locals.breadcrumbs.forEach(function (link) {
    if (link.label === "Account") link.label = "Sites";
  });
  next();
});

CreateBlog.route("/paypal").get(async (req, res, next) => {
  // fetch the latest subscription from PayPal
  if (!req.user.paypal.id) return next();

  await updatePayPalSubscription(req.user.paypal.id);
  res.redirect("/sites/account/create-site");
});

CreateBlog.route("/inform-paypal")

  .all(validateSubscription)

  .all(function (req, res, next) {
    // Only allow users who have blogs for all they've paid
    // to see the pay page!
    if (
      req.user.subscription.quantity <= req.user.blogs.length ||
      parseInt(req.user.paypal.quantity) <= req.user.blogs.length
    ) {
      return next();
    }

    res.redirect(req.baseUrl);
  })

  .all(calculateFee)

  .get(function (req, res) {
    res.locals.breadcrumbs = res.locals.breadcrumbs.slice(0, -1);
    res.locals.breadcrumbs[res.locals.breadcrumbs.length - 1] = {label: 'Create site', last: true};
    
    res.render("dashboard/account/create-site-paypal", {
      title: "Create a site",
      not_paid: true,
      breadcrumb: "Create site",
      paypal_client_id: config.paypal.client_id,
      new_quantity: req.user.blogs.length + 1
    });
  })

  .post(requirePaidPayPalSeat, saveBlog, (req, res) => {
    res.message('/sites/' + req.blog.handle, 'Created site');
  });

CreateBlog.route("/")

  .get(function (req, res) {
    res.locals.blog = {};

    const first_site = req.user.blogs.length === 0;

    // remove breadcrumbs for first site
    if (first_site) {
      res.locals.breadcrumbs = [];
    }

    res.render("dashboard/account/create-site", {
      title: "Create site",
      first_site,
    });
  })


  .post(validateSubscription)

  .post(function (req, res, next) {
    // For institutional accounts, we need to allow them to create
    // at least one blog.
    if (_.isEmpty(req.user.subscription) && req.user.blogs.length === 0) {
      return next();
    }

    // If the user pays for more blogs than they have
    // associated with their account, don't charge
    // them anything. This usually happens when they
    // delete their last blog.
    if (
      req.user.subscription &&
      req.user.subscription.quantity !== null &&
      req.user.subscription.quantity !== undefined &&
      req.user.subscription.quantity > req.user.blogs.length
    ) {
      return next();
    }

    if (req.user.paypal && req.user.paypal.quantity > req.user.blogs.length) {
      return next();
    }

    if (req.body.consent === "true") {
      return next();
    } else {
        
      if (req.user.paypal && req.user.paypal.status) {
        res.redirect(req.baseUrl + "/inform-paypal");
      } else {
        res.redirect(req.baseUrl);
      } 
  }
  })

  // As a matter of policy, we do not prorate the cost of an extra site when it
  // is created; the additional cost is reflected at the next renewal.
  .post(chargeForRemaining, updateSubscription, saveBlog, (req, res) => {

    // For the first site, we immediately redirect to the client
    // setup page so they can sync their folder
    if (req.user.blogs.length === 0) {
      res.redirect('/sites/' + req.blog.handle + '/client');
    } else {
      res.message('/sites/' + req.blog.handle, 'Created site');
    }
  });

function calculateFee (req, res, next) {
  // We dont need to do this for free users
  if (canSkip(req.user)) return next();

  // Skip for PayPal users
  if (!req.user.subscription.status) return next();

  // This happens when the latest subscription is not available from
  // Stripe. Basically the end date for the subscription is in the
  // past and the calculations below produce a negative amount to
  if (end * 1000 < Date.now()) {
    return next(new Error("Your subscription is out of date"));
  }

  var subscription = req.user.subscription;
  var end = subscription.current_period_end;
  var start = subscription.current_period_start;
  var individual = subscription.plan.amount;

  var remaining = end * 1000 - Date.now();
  var length = (end - start) * 1000;

  var ratioToGo = remaining / length;

  var now = Math.round(ratioToGo * individual);
  var later =
    subscription.plan.amount * subscription.quantity + subscription.plan.amount;

  // This is used by the charge function so if you change it, also
  // change the charge function
  req.amount_due_now = now;

  res.locals.monthly = subscription.plan.interval === "month";
  res.locals.interval = subscription.plan.interval;
  res.locals.price = prettyPrice(subscription.plan.amount);
  res.locals.now = prettyPrice(now);
  res.locals.later = prettyPrice(later);
  res.locals.individual = prettyPrice(individual);
  res.locals.first_blog =
    req.user.blogs.length === 0 && req.user.subscription.quantity === 1;

  next();
}

function validateSubscription (req, res, next) {
  if (canSkip(req.user)) return next();

  if (req.user.paypal && req.user.paypal.status === "ACTIVE") {
    return next();
  }

  if (req.user.subscription && req.user.subscription.status === "active") {
    return next();
  }

  res.message(
    "/sites/account/subscription/create",
    new Error("You need an active subscription to create a new blog")
  );
}



function getUserById (uid) {
  return new Promise(function (resolve, reject) {
    User.getById(uid, function (err, user) {
      if (err) return reject(err);
      resolve(user);
    });
  });
}

// The /inform-paypal page is shown precisely when the user has NOT yet paid
// for the seat they're trying to create. Its POST used to call saveBlog with
// no further check, so a PayPal user could create unlimited sites for free by
// POSTing here directly (bypassing the PayPal "revise" step). Before creating
// the site, refetch the live subscription from PayPal and require the paid
// quantity to actually exceed the current blog count - the same entitlement
// the main create-site route enforces. If they still haven't paid, send them
// back to the pay page instead of creating the site.
async function requirePaidPayPalSeat (req, res, next) {
  // The blog count is stable for the duration of this request.
  var blogCount = req.user.blogs.length;

  try {
    if (req.user.paypal && req.user.paypal.id) {
      // updatePayPalSubscription refetches from PayPal and persists it.
      await updatePayPalSubscription(req.user.paypal.id);
      // Reload so we read the freshly-persisted quantity, not the stale one.
      var fresh = await getUserById(req.user.uid);
      if (fresh && fresh.paypal) req.user.paypal = fresh.paypal;
    }
  } catch (err) {
    return next(err);
  }

  var paidQuantity = req.user.paypal
    ? parseInt(req.user.paypal.quantity, 10)
    : 0;

  if (paidQuantity > blogCount) return next();

  res.redirect(req.baseUrl + "/inform-paypal");
}

function saveBlog (req, res, next) {
  var title, handle;

  if (req.body.no_title) {
    title = "Untitled";
    handle = "untitled" + randomChars(5);
  } else if (!req.body.title) {
    return next(new Error("Please enter a title"));
  } else {
    title = req.body.title;
    handle = handleFromTitle(title);
  }

  var newBlog = {
    title: title,
    handle: handle,
    timeZone: req.body.timeZone
  };

  Blog.create(req.user.uid, newBlog, function onCreate (err, blog) {
    if (
      err &&
      err.handle &&
      err.handle.message === "That username was already in use."
    ) {
      newBlog.handle += randomChars(5);
      return Blog.create(req.user.uid, newBlog, onCreate);
    }

    if (err && err.handle) {
      return next(err.handle);
    }

    if (err) {
      return next(err);
    }

    // Begin SSL cert fetching process
    // in the background
    fetch(Blog.extend(blog).url)
      .then(function () {})
      .catch(function () {});

    Email.CREATED_BLOG(req.user.uid);

    req.blog = blog;

    next();
  });
}

function canSkip (user) {
  return (
    !user.subscription.status && !user.paypal.status && user.blogs.length === 0
  );
}

function updateSubscription (req, res, next) {
  // We dont need to do this for free users
  if (canSkip(req.user)) {
    return next();
  }

  // skip for PayPal users
  if (!req.user.subscription.status) return next();

  // This is their first blog, so don't charge the user twice
  if (req.user.blogs.length === 0 && req.user.subscription.quantity === 1) {
    return next();
  }

  stripe.customers.updateSubscription(
    req.user.subscription.customer,
    req.user.subscription.id,
    {
      quantity: req.user.blogs.length + 1,
      prorate: false
    },
    function (err, subscription) {
      if (err) return next(err);

      if (!subscription) return next(new Error(ERR));

      User.set(req.user.uid, { subscription: subscription }, function (err) {
        if (err) return next(err);

        next();
      });
    }
  );
}

function chargeForRemaining (req, res, next) {
  
  // We dont need to do this for free users
  if (!req.user.subscription.status) {
    return next();
  }

  /// We don't need to do this for users with monthly billing
  if (req.user.subscription.plan.interval === "month") return next();

  // This is their first blog, so don't charge the user twice
  if (req.user.blogs.length === 0 && req.user.subscription.quantity === 1) {
    return next();
  }

  if (!req.amount_due_now) return next();

  // Stripe won't charge less than $0.50, we'll just take the hit
  if (req.amount_due_now <= 50) return next();

  stripe.charges.create(
    {
      amount: req.amount_due_now,
      currency: "usd",
      customer: req.user.subscription.customer,
      description: "Charge for the remaining billing period"
    },
    function (err, charge) {
      if (err) return next(err);

      if (!charge) return next(new Error(BAD_CHARGE));

      next();
    }
  );
}

module.exports = CreateBlog;
