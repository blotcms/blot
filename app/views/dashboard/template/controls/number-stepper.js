Array.from(document.querySelectorAll("[data-number-stepper]")).forEach((input) => {
  if (input.dataset.numberStepperReady) return;
  input.dataset.numberStepperReady = "true";

  const label = input.dataset.numberStepperLabel || "value";
  const stepper = document.createElement("div");
  stepper.className = "number-stepper";

  const value = document.createElement("span");
  value.className = "number-stepper__value";
  value.setAttribute("aria-hidden", "true");
  value.dataset.numberStepperValue = "";

  const readout = document.createElement("span");
  readout.className = "number-stepper__readout";

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
  input.parentNode.removeChild(input);
  readout.append(value, input);
  stepper.append(decrease, readout, increase);

  const renderValue = (next, previous, direction) => {
    value.replaceChildren();

    if (next === "") {
      value.textContent = "";
      return;
    }

    const nextChars = Array.from(next);
    const previousChars = Array.from(previous || "");
    const delta = nextChars.length - previousChars.length;

    nextChars.forEach((character, index) => {
      if (!/\d/.test(character)) {
        value.append(document.createTextNode(character));
        return;
      }

      const previousIndex = index - delta;
      const previousCharacter = previousChars[previousIndex];
      if (!/\d/.test(previousCharacter || "") || previousCharacter === character) {
        value.append(document.createTextNode(character));
        return;
      }

      const digitWindow = document.createElement("span");
      digitWindow.className = "number-stepper__digit-window";
      const track = document.createElement("span");
      track.className = `number-stepper__digit-track is-${direction}`;

      const oldDigit = document.createElement("span");
      oldDigit.textContent = previousCharacter;
      const newDigit = document.createElement("span");
      newDigit.textContent = character;

      if (direction === "down") {
        track.append(newDigit, oldDigit);
        track.style.transform = "translateY(-1em)";
        digitWindow.append(track);
        value.append(window);
        track.getBoundingClientRect();
        requestAnimationFrame(() => {
          track.style.transform = "translateY(0)";
        });
      } else {
        track.append(oldDigit, newDigit);
        digitWindow.append(track);
        value.append(window);
        track.getBoundingClientRect();
        requestAnimationFrame(() => {
          track.style.transform = "translateY(-1em)";
        });
      }
    });
  };

  const updateDisplay = (direction) => {
    const next = input.value;
    const previous = value.dataset.value || next;
    if (!direction) {
      const previousNumber = Number(previous);
      const nextNumber = Number(next);
      direction = Number.isFinite(previousNumber) && Number.isFinite(nextNumber) && nextNumber < previousNumber
        ? "down"
        : "up";
    }
    value.dataset.value = next;
    value.classList.toggle("is-editing", document.activeElement === input);
    renderValue(next, previous, direction);
  };

  let boundaryAnimation;
  const animateBoundary = (direction) => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (boundaryAnimation?.playState === "running") return;

    const offset = direction > 0 ? -3 : 3;
    boundaryAnimation = value.animate(
      [
        { transform: "translateY(0)" },
        { transform: `translateY(${offset}px)`, offset: 0.4 },
        { transform: "translateY(0)" },
      ],
      {
        duration: 260,
        easing: "cubic-bezier(0.33, 1, 0.68, 1)",
      },
    );
  };

  updateDisplay("up");

  let nextDirection;
  input.addEventListener("input", () => updateDisplay(nextDirection));
  input.addEventListener("focus", () => value.classList.add("is-editing"));
  input.addEventListener("blur", () => {
    value.classList.remove("is-editing");
    updateDisplay("up");
  });

  [decrease, increase].forEach((button) => {
    const direction = Number(button.dataset.numberStep);
    let holdTimer;
    let holdStartedAt = 0;
    let isHolding = false;
    let suppressNextClick = false;

    const step = () => {
      const stepValue = Number(input.step);
      const increment = Number.isFinite(stepValue) && stepValue > 0 ? stepValue : 1;
      const minimum = input.min === "" ? -Infinity : Number(input.min);
      const maximum = input.max === "" ? Infinity : Number(input.max);
      const min = Number.isFinite(minimum) ? minimum : -Infinity;
      const max = Number.isFinite(maximum) ? maximum : Infinity;
      const entered = Number(input.value);
      const current = Number.isFinite(entered) ? entered : (Number.isFinite(min) ? min : 0);
      const decimals = (String(increment).split(".")[1] || "").length;
      const next = Number(Math.min(max, Math.max(min, current + direction * increment)).toFixed(decimals));

      if (next === entered) {
        if ((direction < 0 && current <= min) || (direction > 0 && current >= max)) {
          animateBoundary(direction);
        }
        return;
      }
      input.value = String(next);
      nextDirection = direction > 0 ? "up" : "down";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      nextDirection = undefined;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      if ((direction < 0 && next <= min) || (direction > 0 && next >= max)) {
        animateBoundary(direction);
      }
    };

    const scheduleRepeat = () => {
      if (!isHolding) return;

      const repeatDelay = 300;
      const accelerationDuration = 1000;
      const slowInterval = 180;
      const fastInterval = 45;
      const elapsed = Math.max(0, Date.now() - holdStartedAt - repeatDelay);
      const acceleration = Math.min(1, elapsed / accelerationDuration);
      const interval = Math.round(slowInterval - (slowInterval - fastInterval) * acceleration);

      holdTimer = setTimeout(() => {
        if (!isHolding) return;
        step();
        scheduleRepeat();
      }, interval);
    };

    const stopHold = () => {
      if (!isHolding) return;
      isHolding = false;
      clearTimeout(holdTimer);
      window.removeEventListener("pointerup", stopHold, true);
      window.removeEventListener("pointercancel", stopHold, true);
      window.removeEventListener("blur", stopHold);
      suppressNextClick = true;
      setTimeout(() => {
        suppressNextClick = false;
      }, 0);
    };

    button.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0 || isHolding) return;
      isHolding = true;
      suppressNextClick = true;
      window.addEventListener("pointerup", stopHold, true);
      window.addEventListener("pointercancel", stopHold, true);
      window.addEventListener("blur", stopHold);
      holdStartedAt = Date.now();
      step();
      holdTimer = setTimeout(scheduleRepeat, 300);
    });

    button.addEventListener("click", () => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      step();
    });
  });
});
