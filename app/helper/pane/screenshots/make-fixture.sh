#!/usr/bin/env bash
# Builds the sample folder used by the docs' folder mock-ups.
set -e
D="${1:-fixture}"
rm -rf "$D"; mkdir -p "$D/Fruits/Tasty" "$D/Pages" "$D/Posts"
echo "Apple" > "$D/Fruits/Apple.md"
echo "Pear" > "$D/Fruits/Pear.txt"
echo "Mango" > "$D/Fruits/Tasty/Mango.md"
echo "About" > "$D/Pages/About.txt"
echo "Contact" > "$D/Pages/Contact.docx"
echo "Hello" > "$D/Introduction.docx"
echo "<a/>" > "$D/index.html"
