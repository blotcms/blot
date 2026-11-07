var basename = require("path").basename;
var parse = require("url").parse;
var fs = require("fs-extra");
var htmlAssets = require("./html_assets");
var assetDirectory = require("./asset_directory");
var download = require("./download");
var lifecycle = require("../lifecycle");
var withCallback = require("helper/withCallback");

async function download_audio(post) {
  // The post's audio (each http(s) <audio src> once) is found by the sandbox's
  // parse-html job, not by Node
  const scanned = await htmlAssets.scan("audio", post.html);

  // The post's audio in one jail, where there are several
  const prefetched = await download.prefetch(scanned.urls, {
    kind: "file",
    check: "audio",
  });

  return downloadAll(post, scanned, prefetched);
}

function directoryOf(post) {
  return new Promise(function (resolve, reject) {
    assetDirectory(post, function (err, directory) {
      if (err) return reject(err);
      resolve(directory);
    });
  });
}

async function downloadAll(post, scanned, prefetched) {
  var replacements = [];

  for (const href of scanned.urls) {
    var name;

    try {
      name = nameFrom(href);
    } catch (e) {
      continue;
    }

    if (name.charAt(0) !== "_") name = "_" + name;

    var data;

    try {
      ({ data } = await download(href, {
        kind: "file",
        check: "audio",
        prefetched: prefetched,
      }));
    } catch (err) {
      console.log("Audio error:", href, err && err.message);
      if (lifecycle.current() && lifecycle.current().signal.aborted) throw err;
      continue;
    }

    try {
      var directory = await directoryOf(post);
      await fs.outputFile(directory + "/" + name, data);
    } catch (e) {
      continue;
    }

    replacements.push([href, name]);
  }

  // With nothing downloaded, the HTML is what the parser wrote back
  if (!replacements.length) {
    post.html = scanned.html;
    return post;
  }

  post.html = await htmlAssets.rewrite("audio", post.html, replacements);
  return post;
}

function nameFrom(src) {
  return "_" + basename(parse(src).pathname);
}

module.exports = withCallback(download_audio);
