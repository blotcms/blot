const Express = require("express");
const Email = new Express.Router();
const User = require("models/user");
const { emailIsTooLong } = require("models/user/auth-limits");

Email.route("/")

  .get(function (req, res) {
    res.render("dashboard/account/email", {
      title: "Change your email",
      breadcrumb: "Email",
    });
  })

  .post(async function (req, res, next) {
    try {
      if (!req.body.email) {
        return next(new Error("Please specify an email address"));
      }

      if (emailIsTooLong(req.body.email)) {
        return next(new Error("Email address is too long"));
      }

      const changes = await User.set(req.user.uid, { email: req.body.email });

      if (changes.length) {
        res.message("Saved your new email address");
      } else {
        res.redirect(req.baseUrl + req.path);
      }
    } catch (err) {
      next(err);
    }
  });

module.exports = Email;
