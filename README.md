# qs

Run tests: `npx tape 'test/**/*.js'`

## `allowReserved` (stringify)

By default, `qs.stringify` percent-encodes every RFC 3986 reserved character in values. Pass `allowReserved: true` to keep the reserved characters that are safe in a query string value unencoded:

```js
var qs = require('./');

qs.stringify({ redirect: 'https://example.com/a?b=1' }, { allowReserved: true });
// 'redirect=https://example.com/a?b=1'
```

Left raw: `: / ? @ ! $ ' ( ) * ; =` — RFC 3986 §3.4 allows these in the query component, and `qs.parse` attaches no structural meaning to them. Still encoded: `&` (the parameter delimiter), `+` (parses back as a space), `,` (splits values when parsing with `comma: true`), `#` (starts the URL fragment), and `[` `]` (key structure: `qs.parse` reads `]=` as the end of a bracketed key, so an `=` directly after a `]` stays encoded too). Any character appearing in a custom `delimiter` also stays encoded. With these rules, `qs.parse` reads the output back into the exact same object.

The option only affects values encoded with the default encoder: keys are encoded as before, and a custom `encoder`'s output is used as-is.
