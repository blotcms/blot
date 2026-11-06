var get = require("../get/entry");
var client = require("models/client");
var async = require("async");

if (require.main === module) {
  main(process.argv[2], function (err) {
    if (err) throw err;
    console.log("Done!");
    process.exit();
  });
}

function main(url, callback) {
  console.log("Looking up", url);
  get(url, function (err, user, blog, entry) {
    if (err) return callback(err);

    console.log("Wiping thumbnails for", entry.path);
    thumbnails(blog, entry, function (err) {
      if (err) return callback(err);

      console.log("Wiping image cache for", entry.path);
      imageCache(blog, entry, callback);
    });
  });
}

function imageCache(blog, entry, callback) {
  if (!entry.thumbnail.small || !entry.thumbnail.small.name) return callback();

  var set = "blog:" + blog.id + ":store:image-cache:everything";

  client
    .sMembers(set)
    .then(function (keys) {
      async.each(
        keys,
        function (key, next) {
          client
            .get(key)
            .then(function (res) {
              if (!res) return next();

              try {
                res = JSON.parse(res);
              } catch (e) {
                console.log(e.message);
                return next();
              }

              if (entry.html.indexOf(res.src) === -1) return next();

              var multi = client.multi();

              console.log(res.src, "wiped");

              multi
                .sRem(set, key)
                .del(key)
                .exec()
                .then(function () {
                  next();
                })
                .catch(next);
            })
            .catch(next);
        },
        callback
      );
    })
    .catch(callback);
}

function thumbnails(blog, entry, callback) {
  if (!entry.thumbnail.small || !entry.thumbnail.small.name) return callback();

  var set = "blog:" + blog.id + ":store:thumbnails:everything";

  client
    .sMembers(set)
    .then(function (keys) {
      async.each(
        keys,
        function (key, next) {
          client
            .get(key)
            .then(function (res) {
              try {
                res = JSON.parse(res);
                if (res.small.name !== entry.thumbnail.small.name)
                  return next();
              } catch (e) {
                console.log("Error", key, e.message);
                return next();
              }

              var multi = client.multi();

              console.log(entry.thumbnail.small.url, "wiped");

              multi
                .sRem(set, key)
                .del(key)
                .exec()
                .then(function () {
                  next();
                })
                .catch(next);
            })
            .catch(next);
        },
        callback
      );
    })
    .catch(callback);
}

module.exports = main;
