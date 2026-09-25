const withAjax = (url) => {
  try {
    const target = new URL(url, window.location.href);
    target.searchParams.set("ajax", "true");
    return target.toString();
  } catch (err) {
    return url.indexOf("?") === -1 ? url + "?ajax=true" : url + "&ajax=true";
  }
};

const refreshTemplatePreview = () => {
  const previewFrame = document.getElementById("full_size_preview");

  if (previewFrame) {
    previewFrame.src += "";
  }
};

const handleAjaxSaveResponse = (response) => {
  const forked =
    response && response.headers && response.headers.get("X-Template-Forked");

  if (forked === "1") {
    window.location = window.location;
    return response;
  }

  if (document.querySelector("[data-syntax-highlighter-preview]")) {
    window.location.reload();
    return response;
  }

  refreshTemplatePreview();
  return response;
};

module.exports = {
  withAjax,
  handleAjaxSaveResponse,
};
