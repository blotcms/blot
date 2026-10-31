// Coalesces rapid edits into one save at a time: waits for the value to
// settle, never has two saves in flight, and saves the latest value once the
// previous request finishes. A failed save marks the form with
// data-save-error until a later save succeeds.
module.exports = function createDebouncedSave(form, save, delay = 180) {
  let timer = null;
  let inFlight = false;
  let pendingValue;

  const flush = () => {
    timer = null;
    if (inFlight || pendingValue === undefined) return;

    const value = pendingValue;
    pendingValue = undefined;
    inFlight = true;

    Promise.resolve()
      .then(() => save(value))
      .then((response) => {
        if (response && response.ok === false) throw new Error("Save failed");
        form.removeAttribute("data-save-error");
      })
      .catch(() => {
        form.setAttribute("data-save-error", "true");
      })
      .finally(() => {
        inFlight = false;
        if (pendingValue !== undefined && !timer) flush();
      });
  };

  return (value) => {
    pendingValue = value;
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  };
};
