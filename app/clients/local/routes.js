var Express = require("express");
var setup = require("./setup");
var disconnect = require("./disconnect");
var Blog = require("models/blog");

// It's important this is an Express router
// and not an Express app for reasons unknown
var Dashboard = Express.Router();

// By the time this middleware is mounted, blot
// has fetched the information about this user.
Dashboard.get("/", async function (req, res, next) {
  try {
    if (req.blog.client !== "local") {
      await Blog.set(req.blog.id, { client: "local" });
      req.blog.client = "local";
    }

    setup(req.blog.id).catch(function (err) {
      console.log("Error setting up", err);
    });

    res.render(__dirname + "/views/index.html");
  } catch (err) {
    next(err);
  }
});

Dashboard.route("/disconnect")
  .get(function (req, res) {
    res.render(__dirname + "/views/disconnect.html");
  })
  .post(function (req, res, next) {
    disconnect(req.blog.id, next);
  });

module.exports = Dashboard;
