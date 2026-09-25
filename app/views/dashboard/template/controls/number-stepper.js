Array.from(document.querySelectorAll("[data-number-stepper]")).forEach((input) => {
  if (input.dataset.numberStepperReady) return;
  input.dataset.numberStepperReady = "true";

  const label = input.dataset.numberStepperLabel || "value";
  const stepper = document.createElement("div");
  stepper.className = "number-stepper";

  const makeButton = (direction, text, action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "number-stepper__step";
    button.dataset.numberStep = direction;
    button.setAttribute("aria-label", `${action} ${label}`);
    button.textContent = text;
    return button;
  };

  const decrease = makeButton("-1", "−", "Decrease");
  const increase = makeButton("1", "+", "Increase");
  input.parentNode.insertBefore(stepper, input);
  stepper.append(decrease, input, increase);

  [decrease, increase].forEach((button) => {
    button.addEventListener("click", () => {
      const direction = Number(button.dataset.numberStep);
      const stepValue = Number(input.step);
      const step = Number.isFinite(stepValue) && stepValue > 0 ? stepValue : 1;
      const minimum = input.min === "" ? -Infinity : Number(input.min);
      const maximum = input.max === "" ? Infinity : Number(input.max);
      const min = Number.isFinite(minimum) ? minimum : -Infinity;
      const max = Number.isFinite(maximum) ? maximum : Infinity;
      const entered = Number(input.value);
      const current = Number.isFinite(entered) ? entered : (Number.isFinite(min) ? min : 0);
      const decimals = (String(step).split(".")[1] || "").length;
      const next = Number(Math.min(max, Math.max(min, current + direction * step)).toFixed(decimals));

      if (next === entered) return;
      input.value = String(next);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
});
