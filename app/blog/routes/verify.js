const { getUserById } = require("../lib/models");
const User = require("models/user");

module.exports = function register(blog) {
  // Called on individual blogs to
  // get the handle associated with them...
  blog.get("/verify/domain-setup", function (req, res, next) {
    if (!req.blog || !req.blog.handle) return next();

    res.set("Cache-Control", "no-cache");
    res.send(req.blog.handle);
  });

  blog.get("/verify/subscription-duration", async function (req, res, next) {
    try {
      if (!req.blog || !req.blog.owner) return res.status(404).end();

      const user = await getUserById(req.blog.owner);
      if (!user) return res.status(404).end();

      const duration = User.subscriptionTenure.getSubscriptionDurationMs(user);

      if (!duration) return res.status(404).end();

      res.set("Cache-Control", "no-cache");
      res.set("Content-Type", "application/json; charset=utf-8");
      res.status(200).send({ duration });
    } catch (err) {
      return next(err);
    }
  });
};
