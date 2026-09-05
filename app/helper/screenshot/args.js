module.exports = [
    // cache
    "--disable-dev-profile",
    "--aggressive-cache-discard",
    "--disable-cache",
    "--disable-application-cache",
    "--disable-offline-load-stale-cache",
    "--disable-gpu-shader-disk-cache",
    "--media-cache-size=0",
    "--disk-cache-size=0",
    // performance
    "--disable-infobars",
    // Containers get a 64MB /dev/shm by default, which a couple of tabs
    // rendering at 2x device scale exhaust; Chromium then hangs in
    // page.screenshot() rather than failing. Write shared memory to /tmp.
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-setuid-sandbox",
    "--no-zygote",
    "--disable-extensions",
    "--disable-plugins",
    "--headless",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-sync",
    "--disable-translate",
    "--no-experiments",
    "--disable-default-apps",
    "--mute-audio",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-notifications",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--autoplay-policy=user-gesture-required",
    "--disable-component-extensions-with-background-pages",
    // rendering
    "--deterministic-fetch",
    "--hide-scrollbars",
    "--font-render-hinting=none",
  ];