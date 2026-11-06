const askForm = document.querySelector('form[action="/questions/ask"]');
const titleInput = document.getElementById("title");

if (askForm && titleInput) {
  const urlParams = new URLSearchParams(window.location.search);
  const title = urlParams.get("title");

  if (title) {
    titleInput.value = title;
  }
}
