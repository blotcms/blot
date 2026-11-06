module.exports = async function (req, res, next) {
  try {
    res.clearCookie("signed_into_blot", { domain: "", path: "/" });
    res.clearCookie("connect.sid", { domain: "", path: "/" });

    if (req.session) {
      await new Promise(function (resolve, reject) {
        req.session.destroy(function (err) {
          if (err) return reject(err);
          resolve();
        });
      });
    }
  } catch (err) {
    return next(err);
  }

  next();
};
