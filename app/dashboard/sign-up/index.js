// Error Messages
var BAD_CHARGE =
  "We were unable to charge your card. Please fill out the form and try again, it should work.";
var NO_EMAIL = "Please enter an email address";
var IN_USE = "That email address is already used by another Blot account.";
var DECLINED = "Your card was declined, please try again.";
var NO_CUSTOMER = "No Customer";

var Express = require("express");
var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var User = require("models/user");
var {
  emailIsTooLong,
  passwordIsTooLong,
} = require("models/user/auth-limits");
var signup = Express.Router();

signup.use(function (req, res, next) {
  if (req.session && req.session.uid) return res.redirect("/sites");

  res.header("Cache-Control", "no-cache");

  return next();
});

signup.use("/paypal", require("./paypal"));

var paymentForm = signup.route("/");
var alreadyPaid = signup.route("/paid/:token");
var passwordForm = signup.route("/create-account");
var firstSite = signup.route("/first-site");

if (config.maintenance) {
  paymentForm.use("/sign-up", function (req, res) {
    res.redirect("/maintenance");
  });
}

// For users who paid by PayPal or institutional customers
// who paid on Stripe I have a tool to skip the form using
// a generated access token.
alreadyPaid.get(function (req, res) {
  res.locals.title = "Sign up";
  res.locals.menu = { "sign-up": "selected" };
  res.locals.error = req.query.error;
  res.render("dashboard/sign-up/paid");
});

alreadyPaid.post(validateEmail, function (req, res, next) {
  // First we make sure that the access token passed is valid.
  User.checkAccessToken(req.params.token, function (err) {
    if (err) {
      return next(
        new Error("Your sign up link is not valid. Please ask for another.")
      );
    }

    req.session.subscription = {};
    req.session.email = req.email;
    res.redirect(req.baseUrl + passwordForm.path);
  });
});

function validateEmail (req, res, next) {
  var email = req.body && req.body.email;

  if (typeof email !== "string" || !email.trim()) {
    return next(new Error(NO_EMAIL));
  }

  if (emailIsTooLong(email.trim())) {
    return next(new Error("Email address is too long"));
  }

  // Normalize the email here before storing it
  // in the browser's session
  email = email.trim().toLowerCase();

  User.getByEmail(email, function (err, existingUser) {
    if (err) return next(err);

    if (existingUser) return next(new Error(IN_USE));

    req.email = email;
    next();
  });
}

paymentForm.get(function (req, res, next) {
  if (
    req.session &&
    req.session.email &&
    (req.session.subscription || req.session.paypal)
  )
    return res.redirect(req.baseUrl + passwordForm.path);

  if (!config.stripe.key) {
    console.error("Warning: Stripe key is not set");
    return res.redirect('/');
  }

  res.locals.title = "Sign up";
  res.locals.menu = { "sign-up": "selected" };
  res.locals.error = req.query.error;
  res.locals.stripe_key = config.stripe.key;
  res.locals.paypal_plan = config.paypal.plan;
  res.locals.paypal_client_id = config.paypal.client_id;
  res.render("dashboard/sign-up");
});

paymentForm.post(validateEmail, function (req, res, next) {
  // Card is a stripe token generated on the client
  const card = req.body && req.body.stripeToken;

  if (!card) return next(new Error(BAD_CHARGE));
  const email = req.email;
  const info = {
    card,
    email,
    plan: config.stripe.plan,
    description: "Blot subscription"
  };

  stripe.customers.create(info, function (err, customer) {
    if (err && err.type === "StripeCardError") {
      return next(new Error(DECLINED));
    }

    if (err) {
      return next(new Error(BAD_CHARGE));
    }

    if (!customer) {
      return next(new Error(NO_CUSTOMER));
    }

    // Store the user's email and charge ID
    // so that when the user returns from
    // Dropbox we know they have a blot account
    req.session.email = email;
    req.session.subscription = customer.subscription;

    res.redirect(req.baseUrl + passwordForm.path);
  });
});

passwordForm.all(function (req, res, next) {
  if (
    !req.session ||
    !req.session.email ||
    (!req.session.subscription && !req.session.paypal)
  )
    return res.redirect(req.baseUrl + paymentForm.path);


  next();
});

passwordForm.get(function (req, res) {
  res.locals.title = "Sign up";
  res.locals.email = req.session.email;
  res.locals.subscription = !!req.session.subscription || !!req.session.paypal;
  res.locals.error = req.query.error;
  res.locals.change_email = req.query.change_email;
  res.render("dashboard/sign-up/password");
});

passwordForm.post(function (req, res, next) {
  var subscription = req.session.subscription || {};
  var paypal = req.session.paypal || {};
  var email = req.body && req.body.email;
  var password = req.body && req.body.password;

  if (typeof email !== "string" || !email.trim()) {
    return next(new Error("Please choose an email address"));
  }

  if (!password) return next(new Error("Please choose a password"));

  if (emailIsTooLong(email.trim())) {
    return next(new Error("Email address is too long"));
  }

  if (passwordIsTooLong(password)) {
    return next(new Error("Password is too long"));
  }

  User.hashPassword(password, function (err, passwordHash) {
    if (err) return next(err);

    User.create(
      email,
      passwordHash,
      subscription,
      paypal,
      function (err, user) {
        if (err) return next(err);

        // The user has changed their email since signing up
        // TODO: add logging
        if (
          subscription &&
          subscription.customer &&
          req.session.email !== user.email
        ) {
          stripe.customers.update(
            subscription.customer,
            { email: user.email },
            function () {
              // TODO: handle this error but it's not
              // all that important
            }
          );
        }

        delete req.session.email;
        delete req.session.subscription;
        delete req.session.paypal;

        // if you change this also change log-in
        res.cookie("signed_into_blot", "true", {
          domain: "",
          path: "/",
          secure: true,
          httpOnly: false,
          maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
          sameSite: "Lax"
        });

        User.scheduleWelcomeEmail(user.uid, function (err) {
          if (err) console.log(err);
        });

        req.session.uid = user.uid;        
        res.redirect("/sites/account/create-site");
      }
    );
  });
});

// This is error handling middleware
// specific to the sign up page
signup.use(function (err, req, res, next) {
  if (err && err.message)
    return res.redirect(
      req.baseUrl + req.path + "?error=" + encodeURIComponent(err.message)
    );

  next();
});


module.exports = signup;
