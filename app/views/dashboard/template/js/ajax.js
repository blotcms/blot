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

const refreshSyntaxHighlighterPreview = () => {
  const preview = document.querySelector("[data-syntax-highlighter-preview]");
  const styleTag = document.querySelector("[data-syntax-highlighter-styles]");

  if (!preview || !styleTag) return;

  fetch(withAjax(window.location.href))
    .then((response) => response.text())
    .then((html) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const newStyleTag = doc.querySelector("[data-syntax-highlighter-styles]");
      const newPreview = doc.querySelector("[data-syntax-highlighter-preview]");

      if (newStyleTag) styleTag.textContent = newStyleTag.textContent;
      if (newPreview) preview.replaceWith(newPreview);
    });
};

const handleAjaxSaveResponse = (response) => {
  const forked =
    response && response.headers && response.headers.get("X-Template-Forked");

  if (forked === "1") {
    window.location = window.location;
    return response;
  }

  if (document.querySelector("[data-syntax-highlighter-preview]")) {
    refreshSyntaxHighlighterPreview();
    return response;
  }

  refreshTemplatePreview();
  return response;
};

module.exports = {
  withAjax,
  handleAjaxSaveResponse,
};
