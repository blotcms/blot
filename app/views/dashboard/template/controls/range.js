
Array.from(document.querySelectorAll('form.number-input')).forEach(function(form){
	const input = form.querySelector('input[type="number"]');
	const csrf = form.querySelector('input[name="_csrf"]');
	if (!input || !csrf) return;

	let timer;
	let inFlight = false;
	let pendingValue;

	const flush = () => {
		timer = null;
		if (inFlight || pendingValue === undefined) return;

		const value = pendingValue;
		pendingValue = undefined;
		const body = new URLSearchParams();
		body.append(input.name, value);
		body.append(csrf.name, csrf.value);
		inFlight = true;

		fetch(window.location.href, { method: "post", body })
			.then((response) => {
				if (response.ok && pendingValue === undefined) {
					document.dispatchEvent(new CustomEvent("template-preview:refresh"));
				}
			})
			.catch(() => {})
			.finally(() => {
				inFlight = false;
				if (pendingValue !== undefined && !timer) flush();
			});
	};

	input.addEventListener('change', () => {
		pendingValue = input.value;
		clearTimeout(timer);
		timer = setTimeout(flush, 180);
	});

});
