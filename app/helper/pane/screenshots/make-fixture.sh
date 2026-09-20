#!/usr/bin/env bash
# Builds the sample folder used by the docs' folder mock-ups: one subfolder (for
# its icon) plus one file of every type we need an icon for. Images and the HTML
# page are Photoshop-style transparency grids (white and mid-grey squares), so
# thumbnails are easy to recognise. Keep in sync with windows.ps1.
set -e
D="${1:-fixture}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ASSETS="$HERE/fixture-assets"
rm -rf "$D"; mkdir -p "$D/Fruits"
echo "Apple" > "$D/Fruits/Apple.md"
# Markdown
cp "$ASSETS/notes.md" "$D/Notes.md"
cp "$ASSETS/draft.md" "$D/Draft.md"
# Images
cp "$ASSETS/checker.png" "$D/Logo.png"
cp "$ASSETS/checker.gif" "$D/Animation.gif"
cp "$ASSETS/checker.jpg" "$D/Photo.jpg"
# Google Docs
echo '{"doc_id":"1abc","resource_id":"document:1abc"}' > "$D/Plan.gdoc"
# Word documents
cp "$ASSETS/report.docx" "$D/Report.docx"
echo "doc" > "$D/Old report.doc"
# Bookmarks
printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>URL</key><string>https://blot.im</string></dict></plist>\n' > "$D/Blot.webloc"
# HTML
cp "$ASSETS/checker.html" "$D/index.html"
# Org mode
echo "* Heading" > "$D/Tasks.org"
# Plain text
echo "Hello" > "$D/About.txt"

# Spread modified (and, on macOS, created) times across the years so each OS's
# date formats get exercised. `touch -t` on macOS also moves the creation date
# back when it is earlier. GNU and BSD date differ, so try both.
i=0
for f in "$D"/* "$D"/Fruits/*; do
  days=$(( (i * i * 37) % 4500 ))
  if date -v-1d +%s >/dev/null 2>&1; then stamp=$(date -v-"${days}"d -v-"$((i * 13))"M +%Y%m%d%H%M); else stamp=$(date -d "$days days ago - $((i * 13)) minutes" +%Y%m%d%H%M); fi
  touch -t "$stamp" "$f"
  i=$((i + 1))
done
touch -t "$(date +%Y%m%d0000)" "$D/Fruits/Apple.md" 2>/dev/null || true
