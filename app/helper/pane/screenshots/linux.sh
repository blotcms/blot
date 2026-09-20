#!/usr/bin/env bash
# Screenshot GNOME Files (Nautilus) under Xvfb.
# usage: linux.sh <light|dark> <out-dir> [scale]   (scale 2 = HiDPI, via GDK_SCALE)
set -uo pipefail
THEME="${1:-light}"; OUT="${2:-out}"; S="${3:-1}"; mkdir -p "$OUT"
W="${W:-490}"; H="${H:-520}"; PAD=$((96 * S))
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
  # No focus ring: my key presses (select-none) switch GTK to keyboard modality, which
  # draws one round the focused row. A user stylesheet switches it off.
  mkdir -p "$HOME/.config/gtk-4.0"
  cat > "$HOME/.config/gtk-4.0/gtk.css" <<'CSS'
*:focus, *:focus-visible, row:focus, row:focus-visible, listview > row, gridview > child, columnview row {
  outline: none;
  outline-color: transparent;
  outline-width: 0;
}
CSS
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
    # No compositor under Xvfb, so windows have square corners and no shadow. Round
    # the corners (GNOME's are) but deliberately leave the shadow off rather than
    # fake one; centre on a 50% grey desktop with generous room around it.
    R=$((12 * S))
    convert "$OUT/window.png" -alpha set \( +clone -alpha transparent -fill white -draw "roundrectangle 0,0 $((WIDTH - 1)),$((HEIGHT - 1)) $R,$R" \) \
      -compose DstIn -composite "$OUT/rounded.png"
    cp "$OUT/rounded.png" "$OUT/shadowed.png"
    convert -size "$((WIDTH + 2 * PAD))x$((HEIGHT + 2 * PAD))" xc:"#808080" "$OUT/shadowed.png" -gravity center -composite "$OUT/$1.png"
    rm -f "$OUT/full.png" "$OUT/window.png" "$OUT/rounded.png" "$OUT/shadowed.png"
  }
  close_nautilus() { pkill nautilus; sleep 3; }

  # list view with the tree expanded (the default capture). Fruits is the 5th row
  # (folders sort among the files); the arrow is at x=41 with the sidebar collapsed.
  gsettings set org.gnome.nautilus.preferences default-folder-viewer 'list-view' || true
  open_nautilus "$W" "$H"
  xdotool mousemove $((X + 41 * S)) $((Y + 326 * S)) click 1; sleep 0.7
  capture "linux-$THEME$SUFFIX"; close_nautilus

  # icon view (the other Nautilus layout)
  gsettings set org.gnome.nautilus.preferences default-folder-viewer 'icon-view' || true
  open_nautilus "$W" "$H"
  capture "linux-$THEME$SUFFIX-icons"; close_nautilus

  # wide list view with the sidebar showing (arrow at x=222)
  gsettings set org.gnome.nautilus.preferences default-folder-viewer 'list-view' || true
  open_nautilus 890 "$H"
  xdotool mousemove $((X + 222 * S)) $((Y + 326 * S)) click 1; sleep 0.7
  capture "linux-$THEME$SUFFIX-sidebar"; close_nautilus

  # Editors: GNOME Text Editor with prose ("text") and source code ("code": line
  # numbers on, and it highlights HTML by itself).
  EDIT="$HOME/editors"; mkdir -p "$EDIT"
  cp "$HERE/fixture-assets/text-sample.txt" "$EDIT/Essay.txt"
  cp "$HERE/fixture-assets/code-sample.html" "$EDIT/index.html"
  gsettings set org.gnome.TextEditor restore-session false || true
  gsettings set org.gnome.TextEditor spellcheck false || true
  gsettings set org.gnome.TextEditor highlight-current-line false || true
  for e in "Essay.txt:text:false" "index.html:code:true"; do
    IFS=: read -r file kind lines <<< "$e"
    gsettings set org.gnome.TextEditor show-line-numbers "$lines" || true
    gnome-text-editor --standalone "$EDIT/$file" >"$OUT/text-editor.log" 2>&1 &
    sleep 8
    WID=""; BEST=0
    for w in $(xdotool search --class gnome-text-editor) $(xdotool search --class TextEditor); do
      eval "$(xdotool getwindowgeometry --shell "$w")"
      if [ $((WIDTH * HEIGHT)) -gt "$BEST" ]; then BEST=$((WIDTH * HEIGHT)); WID="$w"; fi
    done
    xdotool windowsize "$WID" $((W * S)) $((H * S)); sleep 1
    xdotool windowmove "$WID" $((PAD + 40 * S)) $((PAD + 40 * S)); sleep 1
    eval "$(xdotool getwindowgeometry --shell "$WID")"
    echo "$kind window $WID: ${WIDTH}x${HEIGHT}+${X}+${Y}" >> "$OUT/geometry.txt"
    xdotool windowactivate --sync "$WID" || true
    sleep 1
    capture "linux-$THEME$SUFFIX-$kind"
    pkill -x gnome-text-edit; sleep 3; rm -rf "$HOME/.local/share/org.gnome.TextEditor"  # (comm is truncated to 15 chars; -f would match this script itself)
  done

  # Desktop icons: stock GNOME has none. Ubuntu ships Desktop Icons NG (DING), a GJS app
  # that draws GNOME-styled icons for ~/Desktop and can run without GNOME Shell.
  DESK="$HOME/Desktop"; mkdir -p "$DESK"
  # no Home or Trash icons, sorted by name; the files go in in name order
  gsettings set org.gnome.shell.extensions.ding show-home false || true
  gsettings set org.gnome.shell.extensions.ding show-trash false || true
  gsettings set org.gnome.shell.extensions.ding arrangeorder NAME || true
  # (Old report.doc looks like Report.docx: leave it off, so 12 icons fill two columns of six)
  ls -1 "$FIXTURE" | grep -v "^Old report.doc$" | while IFS= read -r f; do cp -a "$FIXTURE/$f" "$DESK/"; done
  mkdir -p "$HOME/.config/gtk-3.0"
  printf "window, window.background, .background { background-color: #808080; background-image: none; }\n" > "$HOME/.config/gtk-3.0/gtk.css"
  DING=/usr/share/gnome-shell/extensions/ding@rastersoft.com/app
  ls "$DING" > "$OUT/ding.log" 2>&1
  # DING's window is transparent, which needs a compositing manager to show the grey desktop
  xcompmgr >"$OUT/xcompmgr.log" 2>&1 &
  sleep 2
  XDG_CURRENT_DESKTOP=ubuntu:GNOME XDG_SESSION_TYPE=x11 gjs "$DING/ding.js" -P "$DING" -D "0:0:1280:560:1:0:0:0:0:0" >>"$OUT/ding.log" 2>&1 &
  sleep 10
  # under GNOME Shell DING is the desktop; here the window manager treats it as a normal
  # window, so mark it as the desktop and put it at the origin
  for w in $(xdotool search --name "DING"); do
    xprop -id "$w" -f _NET_WM_WINDOW_TYPE 32a -set _NET_WM_WINDOW_TYPE _NET_WM_WINDOW_TYPE_DESKTOP >>"$OUT/ding.log" 2>&1
    xprop -id "$w" -f _MOTIF_WM_HINTS 32c -set _MOTIF_WM_HINTS "2, 0, 0, 0, 0" >>"$OUT/ding.log" 2>&1   # no title bar
    xdotool windowmove "$w" 0 0 windowsize "$w" $((1280 * S)) $((560 * S)) >>"$OUT/ding.log" 2>&1
  done
  sleep 4
  import -window root "$OUT/full.png"
  convert "$OUT/full.png" -crop "$((430 * S))x$((560 * S))+0+0" +repage "$OUT/linux-$THEME$SUFFIX-desktop.png"
  rm -f "$OUT/full.png"
  pkill -x gjs; pkill -x xcompmgr; sleep 2

  { echo "nautilus: $(nautilus --version)"; echo "libadwaita: $(dpkg -s libadwaita-1-0 2>/dev/null | grep ^Version)"; lsb_release -d; echo "scale: $S"; } > "$OUT/versions.txt" 2>&1
}
export THEME OUT FIXTURE S SUFFIX W H PAD HERE
dbus-run-session -- bash -c "$(declare -f run); run"
