# Linux (GNOME Files / Nautilus) capture notes

Runner `ubuntu-latest`: Ubuntu 24.04, GNOME Files (Nautilus) 46.4, libadwaita 1.5. That
is one release behind the newest GNOME; use a newer runner image when one appears.
Script: `screenshots/linux.sh`.

## Environment
Xvfb (2560x2400) plus `openbox` (a window manager is needed for keyboard focus) inside
`dbus-run-session`. Packages that matter: `nautilus`, `librsvg2-common`,
`adwaita-icon-theme-full`, `shared-mime-info` (without them icons are broken),
`xdotool`, `imagemagick`, `x11-xserver-utils`.

## Themes
Real libadwaita dark mode needs `ADW_DEBUG_COLOR_SCHEME=prefer-dark` (and the
`color-scheme` gsetting). `GTK_THEME=Adwaita:dark` gives the old GTK3-style dark theme,
which is wrong.

## Retina (2x)
`GDK_SCALE=2` under Xvfb. All coordinates for `xdotool` are physical pixels.

## Window
- Nautilus 46 has no setting or working shortcut to hide the sidebar (F9 does nothing;
  the `toggle-sidebar` D-Bus action only affects the collapsed overlay). libadwaita
  collapses it when the window is narrower than about 500px, so the default 490px
  window has no sidebar. `-sidebar` captures use an 890px window with the sidebar.
- Tree view: `org.gnome.nautilus.list-view use-tree-view true`, then click the arrow
  on the Fruits row (5th row at y=326 logical: folders aren't sorted first, so the row moves when files are added or removed).
- Views: `default-folder-viewer` `list-view` (tree) or `icon-view` (`-icons`).
- Several X windows share the `nautilus` class (helpers are 1x1), so the largest is used.
- Selection cleared with Ctrl-Shift-A. That key press puts GTK in keyboard modality,
  which draws a focus ring round the focused row, so `~/.config/gtk-4.0/gtk.css` turns
  outlines off.

## Corners and shadow
There is no compositor under Xvfb, so windows come out with square corners and no
shadow. The capture rounds the corners (12px x scale, as GNOME does) and deliberately
leaves the shadow off rather than faking one.

## Desktop
`xsetroot -solid '#808080'`; the final image is composited on the same 50% grey.
