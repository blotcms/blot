var basename = require("path").basename;
var parse = require("url").parse;
var htmlAssets = require("./html_assets");
var fs = require("fs-extra");
var assetDirectory = require("./asset_directory");
var boundedDownload = require("./download");
var lifecycle = require("../lifecycle");
var promiseOnly = require("helper/promiseOnly");

async function download_pdfs(post) {
  // if (post.html.indexOf('pdf-embedder') > -1) {
  //   console.log('<<- ', post.html, ' ->>');
  //   throw new Error();
  // }

  var reg = /\[pdf-embedder(.*)\]/gm;

  post.html = post.html.replace(reg, function (str, x) {
    if (x.indexOf("url=")) x = x.split("url=").join("href=");

    return "\n\n<a" + x + ">PDF</a>\n\n";
  });

  // post.html = post.html.split('\\[pdf-embedder url="').join('\n\n<a href="');
  // post.html = post.html.split('"\\]').join("</a>\n\n");

  // The post's links to a PDF (each http(s) <a href> ending in .pdf once) are
  // found by the sandbox's parse-html job, not by Node
  const scanned = await htmlAssets.scan("pdfs", post.html);

  // The post's PDFs in one jail, where there are several
  const prefetched = await boundedDownload.prefetch(scanned.urls, {
    kind: "file",
    check: "pdf",
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

    console.log("Attempting to download", href);

    var data;

    try {
      ({ data } = await boundedDownload(href, {
        kind: "file",
        check: "pdf",
        prefetched,
      }));
    } catch (err) {
      console.log("PDF error:", href, err.name, err.statusCode);
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

  // Changes each downloaded link's href, and its text if that was the URL.
  // From the post's own HTML, so it is parsed and written once, as it was
  // when Node did it.
  post.html = await htmlAssets.rewrite("pdfs", post.html, replacements);
  return post;
}

function nameFrom(src) {
  return "_" + basename(parse(src).pathname);
}

module.exports = promiseOnly(download_pdfs);
