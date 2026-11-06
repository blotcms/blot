const analyticsSelect = document.getElementById("selectAnalytics");

if (analyticsSelect) {
  const trackingIdInput = document.getElementById("trackingIdInput");

  function updateTrackingIdVisibility() {
    if (!trackingIdInput) {
      return;
    }

    const requiresTrackingId =
      analyticsSelect.value !== "None" &&
      ["SimpleAnalytics", "Plausible"].indexOf(analyticsSelect.value) === -1;

    if (!requiresTrackingId) {
      trackingIdInput.style.display = "none";
      return;
    }

    const label = trackingIdInput.querySelector("span");
    if (label) {
      label.textContent =
        analyticsSelect.value === "Cloudflare" ? "Token:" : "Tracking ID:";
    }

    trackingIdInput.style.display = "block";
  }

  analyticsSelect.addEventListener("change", updateTrackingIdVisibility);
  updateTrackingIdVisibility();
}
