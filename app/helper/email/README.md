# Email

`index.js` sends one email per template in `admin/` (to the admin) and `user/`
(to the user whose uid is passed), named after the method: `email.SERVER_START(uid, locals)`
renders `admin/SERVER_START.txt`. A new template needs its name added to `MESSAGES`.

## Sending

Each message function (`email.WELCOME(uid, locals)`) returns a promise that
resolves when the message has been handed to Mailgun and rejects if the send
fails. Await it where the caller needs to know the send worked. Call it without
awaiting for fire-and-forget: the function logs a failed send itself
(`Email: WELCOME failed to send <uid> <message>`) and marks the rejection
handled, so an unawaited call can't cause an unhandled rejection. There is no
callback argument.

## Template format

- Line 1 is the subject, line 2 is blank, and the rest is the body.
- Both are [Mustache](https://github.com/janl/mustache.js) templates rendered with `locals`.
- The body is then rendered from Markdown to HTML with `marked`. The subject stays plain text.

## Escaping: when to use `{{{triple}}}`

`{{name}}` HTML-escapes the value: `&`, `<`, `>`, `"`, `'`, `/`, `` ` `` and `=`
become entities such as `&#x3D;`. In body prose that's what we want, since the
entity renders as the character in the HTML email. In two places it isn't, and
the reader sees the entity literally:

- **The subject.** It's plain text, so nothing decodes the entities. A
  subject of `{{event}}` with `Exited pid=153` arrived as `Exited pid&#x3D;153`.
- **Code spans and code blocks.** `marked` escapes what is inside them itself, so an
  entity Mustache produced is escaped a second time and shows up as `&#x3D;`.

Use `{{{name}}}` in both. It's safe there: the subject is never parsed as HTML,
and `marked` escapes what's inside code. Keep `{{name}}` everywhere else in the
body, where an unescaped value would be parsed as HTML.

`app/helper/tests/email.js` fails on a double-stache variable in a subject or a
code span.
