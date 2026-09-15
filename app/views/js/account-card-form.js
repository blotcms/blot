var form = document.getElementById('payment-form');
var cardContainer = document.getElementById('card');

if (form && cardContainer && window.Stripe) {
  var stripeKey = form.dataset.stripeKey;

  if (stripeKey) {
    var stripe = Stripe(stripeKey);
    var elements = stripe.elements();

    var style = {
      base: {
        fontSize: '16px',
        color: '#000',
        iconColor: '#9ba0ac',
        '::placeholder': {
          color: '#9ba0ac'
        }
      }
    };

    var card = elements.create('card', { style: style });
    card.mount('#card');

    function setFocusColor(elementId) {
      document.getElementById(elementId).style.borderColor = 'var(--accent-color)';
      document.querySelector('label[for="' + elementId + '"]').style.color = 'var(--accent-color)';
    }

    function resetFocusColor(elementId) {
      document.getElementById(elementId).style.borderColor = 'var(--border-color)';
      document.querySelector('label[for="' + elementId + '"]').style.color = '';
    }

    function renderError(message) {
      var errorElement = document.getElementById('error');
      errorElement.textContent = message;
      errorElement.style.display = 'block';
      form.querySelector('button[type="submit"]').classList.remove('working');
    }

    function stripeTokenHandler(token) {
      var hiddenInput = form.querySelector('input.stripeToken');
      hiddenInput.setAttribute('value', token.id);
      form.submit();
    }

    card.on('focus', function () {
      document.getElementById('error').style.display = 'none';
      form.querySelector('button[type="submit"]').classList.remove('working');
      setFocusColor(card._parent.id);
    });

    card.on('blur', function () {
      resetFocusColor(card._parent.id);
    });

    form.addEventListener('submit', function (event) {
      form.querySelector('button[type="submit"]').classList.add('working');
      event.preventDefault();

      stripe.createToken(card).then(function (result) {
        if (result.error) {
          renderError(result.error.message);
          return;
        }

        stripeTokenHandler(result.token);
      });
    });
  }
}
