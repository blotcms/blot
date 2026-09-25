const ajax = require('../js/ajax.js');
const withAjax = ajax.withAjax;
const handleAjaxSaveResponse = ajax.handleAjaxSaveResponse;
const getFontPicker = require('./font-picker');

const picker = getFontPicker();
const getPickerElement = () => document.querySelector('[data-template-font-picker]');

const submitUpdate = (form, name, value) => {
  const body = new URLSearchParams();
  body.append(name, value);

  const csrfInput = form.querySelector('input[name="_csrf"]');
  if (csrfInput) body.append(csrfInput.name, csrfInput.value);

  form.dispatchEvent(
    new CustomEvent("template-local-changed", {
      bubbles: true,
      detail: { group: "fonts" },
    })
  );

  fetch(withAjax(window.location.href), { method: 'post', body }).then(
    handleAjaxSaveResponse
  );
};

Array.from(document.querySelectorAll('[data-font-picker-form]')).forEach(form => {
  const trigger = form.querySelector('[data-font-picker-trigger]');
  const label = form.querySelector('[data-font-picker-label]');
  const valueInput = form.querySelector('[data-font-picker-value]');

  if (!trigger || !label || !valueInput) return;

  trigger.setAttribute('aria-expanded', 'false');

  const openPicker = () => {
    picker.cancelHide();
    trigger.setAttribute('aria-expanded', 'true');
    picker.show({
      anchor: trigger,
      currentValue: valueInput.value,
      onSelect(option) {
        const html = option.html || 'Select a font';
        valueInput.value = option.id || '';
        label.innerHTML = html;
        submitUpdate(form, valueInput.name, valueInput.value);
      },
      onHide() {
        trigger.setAttribute('aria-expanded', 'false');
      }
    });
  };

  const scheduleHide = () => picker.scheduleHide();
  const cancelHide = () => picker.cancelHide();

  trigger.addEventListener('click', event => {
    event.preventDefault();
    if (trigger.getAttribute('aria-expanded') === 'true') {
      picker.hide();
      return;
    }
    openPicker();
  });

  trigger.addEventListener('keydown', event => {
    const activationKeys = ['Enter', ' ', 'Spacebar'];
    if (!activationKeys.includes(event.key)) return;
    event.preventDefault();
    if (trigger.getAttribute('aria-expanded') === 'true') {
      picker.hide();
      return;
    }
    openPicker();
  });

  trigger.addEventListener('blur', event => {
    const next = event.relatedTarget;
    const pickerElement = getPickerElement();
    if (
      next &&
      (trigger.contains(next) || (pickerElement && pickerElement.contains(next)))
    ) {
      return;
    }
    scheduleHide();
  });

  form.querySelectorAll('input[type="number"]').forEach(input => {
    input.addEventListener('change', () => {
      submitUpdate(form, input.name, input.value);
    });
  });

});
