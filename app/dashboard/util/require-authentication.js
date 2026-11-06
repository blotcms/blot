module.exports = function (req, res, next) {
  if (req.session && req.session.uid) {
    return next();
  }

  next(new Error("NOUSER"));
};
