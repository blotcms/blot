Name files like this:

YYYY-ID-SEASON.txt

To send out a file, ssh into server, then login to a running container and run:

node scripts/email/newsletter YYYY-ID-SEASON.txt

To preview a newsletter in development environment:

npm run preview-newsletter

Find PRs using this search query:

https://github.com/blotcms/blot/pulls?q=sort%3Amerged-asc+is%3Amerged+merged%3A%3E%3D2023-10-03+author%3A%40me+

Then look at the commits too just in case:

https://github.com/blotcms/blot

Discuss the following and no more:
- New features
- Fixed bugs
- Downtime
- Featured sites