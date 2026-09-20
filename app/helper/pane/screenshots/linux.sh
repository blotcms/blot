#!/usr/bin/env bash
# Screenshot GNOME Files (Nautilus) under Xvfb.
# usage: linux.sh <light|dark> <out-dir> [scale]   (scale 2 = HiDPI, via GDK_SCALE)
set -uo pipefail
THEME="${1:-light}"; OUT="${2:-out}"; S="${3:-1}"; mkdir -p "$OUT"
W="${W:-480}"; H="${H:-520}"; PAD=$((96 * S))
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
  gsettings set org.gnome.nautilus.list-view use-tree-view true || true
  gsettings set org.gnome.desktop.interface color-scheme "prefer-$THEME" || true
  gsettings list-recursively org.gnome.nautilus > "$OUT/gsettings.txt" 2>&1

  # 50% grey desktop, which makes the window's drop shadow easy to see
  xsetroot -solid "#808080"

  # a window manager is needed for keyboard focus (and the window needs focus)
  openbox >"$OUT/openbox.log" 2>&1 &
  sleep 2

  open_nautilus() {  # args: width height (logical px)
    nautilus --new-window "$FIXTURE" >"$OUT/nautilus.log" 2>&1 &
    sleep 8
    # several X windows share the class (helpers are 1x1); pick the largest one
    WID=""; BEST=0
    for w in $(xdotool search --class nautilus); do
      eval "$(xdotool getwindowgeometry --shell "$w")"
      if [ $((WIDTH * HEIGHT)) -gt "$BEST" ]; then BEST=$((WIDTH * HEIGHT)); WID="$w"; fi
    done
    # Nautilus collapses its sidebar below ~500px wide
    xdotool windowsize "$WID" $(($1 * S)) $(($2 * S)); sleep 1
    xdotool windowmove "$WID" $((PAD + 40 * S)) $((PAD + 40 * S)); sleep 1
    eval "$(xdotool getwindowgeometry --shell "$WID")"
    echo "window $WID: ${WIDTH}x${HEIGHT}+${X}+${Y}" >> "$OUT/geometry.txt"
    # focus via the window manager (a click could select an item or hit a button)
    xdotool windowactivate --sync "$WID" || xdotool windowfocus "$WID" || true
    sleep 0.5
  }
  capture() {  # arg: output name
    xdotool key --clearmodifiers ctrl+shift+a; sleep 0.5  # clear the selection
    xdotool mousemove $((X + WIDTH / 2)) $((Y + HEIGHT + 2 * PAD)); sleep 1
    import -window root "$OUT/full.png"
    convert "$OUT/full.png" -crop "${WIDTH}x${HEIGHT}+${X}+${Y}" +repage "$OUT/window.png"
    # No compositor under Xvfb, so give the window its rounded corners and shadow
    # ourselves, on a 50% grey desktop with generous room around it.
    R=$((12 * S))
    convert "$OUT/window.png" -alpha set \( +clone -alpha transparent -fill white -draw "roundrectangle 0,0 $((WIDTH - 1)),$((HEIGHT - 1)) $R,$R" \) \
      -compose DstIn -composite "$OUT/rounded.png"
    convert "$OUT/rounded.png" \( +clone -background black -shadow 45x$((20 * S))+0+$((10 * S)) \) +swap -background none -layers merge +repage "$OUT/shadowed.png"
    convert -size "$((WIDTH + 2 * PAD))x$((HEIGHT + 2 * PAD))" xc:"#808080" "$OUT/shadowed.png" -gravity center -composite "$OUT/$1.png"
    rm -f "$OUT/full.png" "$OUT/window.png" "$OUT/rounded.png" "$OUT/shadowed.png"
  }
  close_nautilus() { pkill nautilus; sleep 3; }

  # list view with the tree expanded (the default capture). Fruits is the 6th row
  # (folders sort among the files); the arrow is at x=41 with the sidebar collapsed.
  gsettings set org.gnome.nautilus.preferences default-folder-viewer 'list-view' || true
  open_nautilus "$W" "$H"
  xdotool mousemove $((X + 41 * S)) $((Y + 368 * S)) click 1; sleep 0.7
  capture "linux-$THEME$SUFFIX"; close_nautilus

  # icon view (the other Nautilus layout)
  gsettings set org.gnome.nautilus.preferences default-folder-viewer 'icon-view' || true
  open_nautilus "$W" "$H"
  capture "linux-$THEME$SUFFIX-icons"; close_nautilus

  # wide list view with the sidebar showing (arrow at x=222)
  gsettings set org.gnome.nautilus.preferences default-folder-viewer 'list-view' || true
  open_nautilus 890 "$H"
  xdotool mousemove $((X + 222 * S)) $((Y + 368 * S)) click 1; sleep 0.7
  capture "linux-$THEME$SUFFIX-sidebar"; close_nautilus

  { echo "nautilus: $(nautilus --version)"; echo "libadwaita: $(dpkg -s libadwaita-1-0 2>/dev/null | grep ^Version)"; lsb_release -d; echo "scale: $S"; } > "$OUT/versions.txt" 2>&1
}
export THEME OUT FIXTURE S SUFFIX W H PAD HERE
dbus-run-session -- bash -c "$(declare -f run); run"
