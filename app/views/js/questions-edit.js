const tagsInput = document.querySelector('input[name="tags"]');

if (tagsInput && window.Tagify) {
  new window.Tagify(tagsInput, {
    originalInputValueFormat: (valuesArr) =>
      valuesArr.map((item) => item.value).join(","),
  });
}
