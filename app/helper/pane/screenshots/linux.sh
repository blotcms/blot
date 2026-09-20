#!/usr/bin/env bash
# Screenshot GNOME Files (Nautilus) under Xvfb. usage: linux.sh <light|dark> <out-dir>
set -uo pipefail
THEME="${1:-light}"; OUT="${2:-out}"; mkdir -p "$OUT"
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$HOME/Your site"
bash "$HERE/make-fixture.sh" "$FIXTURE"

export GDK_BACKEND=x11
if [ "$THEME" = dark ]; then
  export ADW_DEBUG_COLOR_SCHEME=prefer-dark GTK_THEME=Adwaita:dark
else
  export ADW_DEBUG_COLOR_SCHEME=prefer-light
fi

run() {
  # tree view in list mode, like the docs' folder mock-ups
  gsettings set org.gnome.nautilus.preferences default-folder-viewer 'list-view' || true
  gsettings set org.gnome.nautilus.list-view use-tree-view true || true
  gsettings set org.gnome.desktop.interface color-scheme "prefer-$THEME" || true
  nautilus --new-window "$FIXTURE" >"$OUT/nautilus.log" 2>&1 &
  sleep 8
  xdotool search --class nautilus | head -3 > "$OUT/windows.txt" || true
  WID="$(xdotool search --class nautilus | head -1)"
  if [ -n "$WID" ]; then
    xdotool windowmove "$WID" 40 40 windowsize "$WID" 900 560 || true
    sleep 2
    # expand every folder in the tree
    xdotool key --window "$WID" shift+Right || true
    sleep 1
  fi
  import -window root "$OUT/linux-$THEME-root.png"
  [ -n "$WID" ] && import -window "$WID" "$OUT/linux-$THEME-window.png" || true
  { echo "nautilus: $(nautilus --version)"; echo "libadwaita: $(dpkg -s libadwaita-1-0 2>/dev/null | grep ^Version)"; lsb_release -d; } > "$OUT/versions.txt" 2>&1
}
export -f run 2>/dev/null || true
export THEME OUT FIXTURE
dbus-run-session -- bash -c "$(declare -f run); run"
