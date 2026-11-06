function initQuestionsTextarea() {
  const textarea = document.getElementById("body");

  if (!textarea || !window.mdEditor) {
    return;
  }

  if (textarea.dataset.mdEditorInitialized === "true") {
    return;
  }

  textarea.dataset.mdEditorInitialized = "true";

  const editor = new window.mdEditor({
    element: textarea,
    insertTexts: {
      link: ["[", "](https://)"],
      image: ["![](https://", ")"],
    },
  });

  const urlParams = new URLSearchParams(window.location.search);
  const body = urlParams.get("body");

  if (body) {
    editor.value(body);
  }
}

initQuestionsTextarea();
