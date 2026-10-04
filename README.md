# qs

Run tests: `npx tape 'test/**/*.js'`

## allowReserved

By default `qs.stringify` percent-encodes every reserved character. Pass `{ allowReserved: true }` to leave RFC 3986 reserved characters verbatim inside **values** (keys keep their existing encoding); it is off by default. For example, `qs.stringify({ redirect: 'https://example.com/a?b=1' }, { allowReserved: true })` produces `redirect=https://example.com/a?b=1`.

The output always round-trips through `qs.parse` with the matching options, so the reserved characters that would change parsing or the URL stay percent-encoded: `&` and `#` would split or truncate the query when appended to a URL, `+` is decoded as a space, and `[` and `]` are not allowed unencoded in a query. `=` stays encoded right after an encoded `]` (the pair is emitted as `%5D%3D`), otherwise `qs.parse` mistakes it for the key/value boundary. A reserved character used as a separator is also encoded in values: the custom `delimiter`, and the comma with `arrayFormat: 'comma'` (a literal comma in a plain scalar is left as-is). `encode: false` and a user-supplied `encoder` are left untouched, and switching the option off leaves the output byte-for-byte unchanged.
