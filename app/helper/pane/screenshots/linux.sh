#!/usr/bin/env bash
# Screenshot GNOME Files (Nautilus) under Xvfb.
# usage: linux.sh <light|dark> <out-dir> [scale]   (scale 2 = HiDPI, via GDK_SCALE)
set -uo pipefail
THEME="${1:-light}"; OUT="${2:-out}"; S="${3:-1}"; NARROW="${NARROW:-560}"; mkdir -p "$OUT"
HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$HOME/Your site"
bash "$HERE/make-fixture.sh" "$FIXTURE"
SUFFIX=""; [ "$S" != 1 ] && SUFFIX="@${S}x"

export GDK_BACKEND=x11 GDK_SCALE="$S"
if [ "$THEME" = dark ]; then
  export ADW_DEBUG_COLOR_SCHEME=prefer-dark
else
  export ADW_DEBUG_COLOR_SCHEME=prefer-light
fi

run() {
  # tree view in list mode, like the docs' folder mock-ups, without the sidebar
  gsettings set org.gnome.nautilus.preferences default-folder-viewer 'list-view' || true
  gsettings set org.gnome.nautilus.list-view use-tree-view true || true
  gsettings set org.gnome.nautilus.window-state start-with-sidebar false || true
  gsettings set org.gnome.desktop.interface color-scheme "prefer-$THEME" || true
  gsettings list-recursively org.gnome.nautilus > "$OUT/gsettings.txt" 2>&1
  xsetroot -solid "#c8c8c8"
  # a window manager is needed for keyboard focus (and the window needs focus)
  openbox >"$OUT/openbox.log" 2>&1 &
  sleep 2
  nautilus --new-window "$FIXTURE" >"$OUT/nautilus.log" 2>&1 &
  sleep 8
  # several X windows share the class (helpers are 1x1); pick the largest one
  WID=""; BEST=0
  for w in $(xdotool search --class nautilus); do
    eval "$(xdotool getwindowgeometry --shell "$w")"
    if [ $((WIDTH * HEIGHT)) -gt "$BEST" ]; then BEST=$((WIDTH * HEIGHT)); WID="$w"; fi
  done
  # Nautilus 46 has no setting to hide the sidebar, but libadwaita collapses it
  # when the window is narrow, so use a narrow window.
  xdotool windowsize "$WID" $((NARROW * S)) $((550 * S)); sleep 1
  xdotool windowmove "$WID" $((100 * S)) $((100 * S)); sleep 1
  eval "$(xdotool getwindowgeometry --shell "$WID")"
  echo "window $WID: ${WIDTH}x${HEIGHT}+${X}+${Y}" > "$OUT/geometry.txt"
  xdotool mousemove $((X + 500 * S)) $((Y + 400 * S)) click 1; sleep 0.5
  xdotool windowactivate --sync "$WID" || xdotool windowfocus "$WID" || true
  sleep 0.5
  # expand folders bottom-up so row positions above don't shift, then the
  # nested folder inside Fruits (rows are 52px apart, arrows at x=37)
  for y in 274 222 118; do xdotool mousemove $((X + 37 * S)) $((Y + y * S)) click 1; sleep 0.5; done
  xdotool mousemove $((X + 57 * S)) $((Y + 274 * S)) click 1; sleep 0.5
  xdotool mousemove $((X + 700 * S)) $((Y + 500 * S)); sleep 1
  import -window root "$OUT/full.png"
  convert "$OUT/full.png" -crop "${WIDTH}x${HEIGHT}+${X}+${Y}" +repage "$OUT/window.png"
  # No compositor under Xvfb, so give the window its rounded corners and shadow
  # ourselves, on a mild grey desktop with room around it.
  R=$((12 * S))
  convert "$OUT/window.png" -alpha set \( +clone -alpha transparent -fill white -draw "roundrectangle 0,0 $((WIDTH - 1)),$((HEIGHT - 1)) $R,$R" \) \
    -compose DstIn -composite "$OUT/rounded.png"
  convert "$OUT/rounded.png" \( +clone -background black -shadow 45x$((20 * S))+0+$((10 * S)) \) +swap -background none -layers merge +repage "$OUT/shadowed.png"
  convert -size "$((WIDTH + 120 * S))x$((HEIGHT + 120 * S))" xc:"#c8c8c8" "$OUT/shadowed.png" -gravity center -composite "$OUT/linux-$THEME$SUFFIX.png"
  rm -f "$OUT/full.png" "$OUT/window.png" "$OUT/rounded.png" "$OUT/shadowed.png"
  { echo "nautilus: $(nautilus --version)"; echo "libadwaita: $(dpkg -s libadwaita-1-0 2>/dev/null | grep ^Version)"; lsb_release -d; echo "scale: $S"; } > "$OUT/versions.txt" 2>&1
}
export THEME OUT FIXTURE S SUFFIX NARROW
dbus-run-session -- bash -c "$(declare -f run); run"
