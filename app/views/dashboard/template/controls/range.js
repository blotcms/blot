const createDebouncedSave = require('../js/debounced-save');

Array.from(document.querySelectorAll('form.number-input')).forEach(function(form){
	const input = form.querySelector('input[type="number"]');
	const csrf = form.querySelector('input[name="_csrf"]');
	if (!input || !csrf) return;

	const scheduleSave = createDebouncedSave(form, (value) => {
		const body = new URLSearchParams();
		body.append(input.name, value);
		body.append(csrf.name, csrf.value);

		return fetch(window.location.href, { method: "post", body }).then((response) => {
			if (response.ok) document.dispatchEvent(new CustomEvent("template-preview:refresh"));
			return response;
		});
	});

	input.addEventListener('change', () => scheduleSave(input.value));
});
