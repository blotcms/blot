// A template screenshot that was still being taken when the page was
// rendered (data-screenshot="pending", see
// app/dashboard/site/template/screenshots.js) is asked for again a few times,
// so it replaces the old image without a reload. The image's URL redirects
// to whichever screenshot is current.
var RETRIES = [10000, 25000, 60000];

document
  .querySelectorAll('img[data-screenshot="pending"]')
  .forEach(function (img) {
    var base = img.getAttribute("src");

    RETRIES.forEach(function (delay) {
      setTimeout(function () {
        img.src =
          base + (base.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();
      }, delay);
    });
  });
