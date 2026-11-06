var iframe = document.querySelector("iframe");
var syncConfig = document.querySelector(
  "[data-preview-origin][data-preview-post-url]"
);

if (!iframe || !syncConfig) {
  return;
}

var previewOrigin = syncConfig.dataset.previewOrigin;
var postUrl = syncConfig.dataset.previewPostUrl;

if (!previewOrigin || !postUrl) {
  return;
}

var receiveMessage = function receiveMessage(e) {
  if (e.origin !== previewOrigin) return;

  var path = e.data.slice("iframe:".length);

  var http = new XMLHttpRequest();
  var params = "previewPath=" + path;
  http.open("POST", postUrl, true);
  http.setRequestHeader("Content-type", "application/x-www-form-urlencoded");
  http.send(params);
};

window.addEventListener("message", receiveMessage, false);
