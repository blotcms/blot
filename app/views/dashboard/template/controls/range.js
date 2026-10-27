
Array.from(document.querySelectorAll('form.number-input')).forEach(function(form){
	
	form.querySelectorAll('input').forEach(function(node){
		node.addEventListener('change',  (event) => {

			// construct the body based on the single input or button that was clicked
			const body = new URLSearchParams();

			body.append(node.name, node.value);
			body.append("_csrf", form.querySelector('input[name="_csrf"]').value);
			
			fetch(window.location.href, { method: "post", body }).then(function (response) {
				document.dispatchEvent(new CustomEvent("template-preview:refresh"));
			});

			event.preventDefault();
			return false;
			})
	})

});