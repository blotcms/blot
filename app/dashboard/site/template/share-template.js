const express = require("express");
const share = express.Router();
const Template = require("models/template");

share
  .route("/:shareID")
  .all(function (req, res, next) {
    Template.getByShareID(req.params.shareID, function (err, template) {
      if (err || !template) return next(err || new Error("No template"));
      req.template = res.locals.template = template;
      next();
    });
  })

  .get(function (req, res) {
    res.render("dashboard/template/share");
  })

  .post(function (req, res, next) {
    // find the blog which matches the blog property of req.body
    req.blog = req.blogs.filter((blog) => blog.id === req.body.blog)[0];

    // if no blog is found, use the first blog
    if (!req.blog) req.blog = req.blogs[0];

    req.body = {
      name: req.template.name,
      cloneFrom: req.template.id,
      shared: true,
      redirect: `/sites/${req.blog.handle}/template`,
    };

    next();
  }, require("./save/newTemplate"));

module.exports = share;
