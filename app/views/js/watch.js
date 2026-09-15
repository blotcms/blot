const WATCH_PLAYER_SCRIPT = 'https://assets.mediadelivery.net/playerjs/player-0.1.0.min.js';

(function () {
  const screen = document.querySelector('[data-watch-screen]');
  if (!screen) return;

  const frame = screen.querySelector('iframe');
  const trigger = document.querySelector('[data-watch-trigger]');
  const close = screen.querySelector('[data-watch-close]');
  const standalone = document.body.classList.contains('watch-page');

  let active = standalone;
  let player;
  let playerPromise;
  let playerScriptPromise;

  function loadPlayerScript() {
    if (window.playerjs) return Promise.resolve(window.playerjs);
    if (playerScriptPromise) return playerScriptPromise;

    playerScriptPromise = new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = WATCH_PLAYER_SCRIPT;
      script.async = true;
      script.onload = function () {
        resolve(window.playerjs);
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });

    return playerScriptPromise;
  }

  function createPlayer() {
    if (player) return Promise.resolve(player);
    if (playerPromise) return playerPromise;
    if (!frame) return Promise.resolve();

    playerPromise = loadPlayerScript()
      .then(function (playerjs) {
        if (!playerjs || !playerjs.Player) return;

        player = new playerjs.Player(frame);
        player.on('ready', function () {
          if (active) playVideo();
        });

        return player;
      })
      .catch(function () {
        // The iframe remains usable if the Player.js helper cannot load.
      });

    return playerPromise;
  }

  function playVideo() {
    if (!player || !active) return;

    try {
      const result = player.play();
      if (result && typeof result.catch === 'function') result.catch(function () {});
    } catch (error) {}
  }

  function setScreenState(isActive) {
    if (!isActive && player) {
      try {
        const result = player.pause();
        if (result && typeof result.catch === 'function') result.catch(function () {});
      } catch (error) {}
    }

    active = isActive;
    document.body.classList.toggle('is-watching', isActive);
    screen.classList.toggle('is-active', isActive);
    screen.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  }

  function openWatch(updateUrl) {
    if (updateUrl && window.location.pathname !== '/watch') {
      window.history.pushState({ watch: true }, '', '/watch');
    }

    setScreenState(true);
    createPlayer().then(playVideo);
    if (close) close.focus();
  }

  function closeWatch(event) {
    if (event) event.preventDefault();

    if (standalone) {
      window.location.href = '/';
      return;
    }

    if (window.history.state && window.history.state.watch) {
      window.history.back();
      return;
    }

    window.history.replaceState({}, '', '/');
    setScreenState(false);
    if (trigger) trigger.focus();
  }

  function preloadPlayer() {
    // The eager iframe starts fetching the video immediately. Initialize the
    // Player.js bridge during idle time so opening the overlay only has to play.
    if (window.requestIdleCallback) {
      window.requestIdleCallback(createPlayer, { timeout: 2000 });
    } else {
      window.setTimeout(createPlayer, 0);
    }
  }

  if (trigger) {
    trigger.addEventListener('click', function (event) {
      event.preventDefault();
      openWatch(true);
    });
  }

  if (close) close.addEventListener('click', closeWatch);

  window.addEventListener('popstate', function () {
    if (window.location.pathname === '/watch') {
      openWatch(false);
    } else if (!standalone) {
      setScreenState(false);
      if (trigger) trigger.focus();
    }
  });

  if (standalone) {
    openWatch(false);
  } else {
    preloadPlayer();
  }
})();
