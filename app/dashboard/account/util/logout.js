module.exports = function (req, res, next) {
  res.clearCookie("signed_into_blot", { domain: "", path: "/" });
  res.clearCookie("connect.sid", { domain: "", path: "/" });

  if (!req.session) return next();

  req.session.destroy(function (err) {
    if (err) return next(err);

    next();
  });
};
