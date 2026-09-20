#!/usr/bin/env bash
# Builds the sample folder used by the docs' folder mock-ups: one subfolder (for
# its icon) plus one file of every type we need an icon for. Keep in sync with
# windows.ps1.
set -e
D="${1:-fixture}"
rm -rf "$D"; mkdir -p "$D/Fruits"
PNG=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
GIF=R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7
echo "Apple" > "$D/Fruits/Apple.md"
# Markdown
echo "# Notes" > "$D/Notes.markdown"
echo "# Draft" > "$D/Draft.md"
# Images
echo "$PNG" | base64 -d > "$D/Logo.png"
echo "$GIF" | base64 -d > "$D/Animation.gif"
echo "jpeg" > "$D/Photo.jpg"
# Google Docs
echo '{"doc_id":"1abc","resource_id":"document:1abc"}' > "$D/Plan.gdoc"
# Word documents
echo "docx" > "$D/Report.docx"
echo "doc" > "$D/Old report.doc"
# Bookmarks
printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>URL</key><string>https://blot.im</string></dict></plist>\n' > "$D/Blot.webloc"
printf '[InternetShortcut]\nURL=https://blot.im\n' > "$D/Blot.url"
# HTML
echo "<h1>Hello</h1>" > "$D/index.html"
# Org mode
echo "* Heading" > "$D/Tasks.org"
# Plain text
echo "Hello" > "$D/About.txt"
