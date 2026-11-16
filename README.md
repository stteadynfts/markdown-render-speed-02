# markdown-render-speed-02

A fast drop-in for marked 18.1.3 (GFM defaults). `parse(markdown)` returns
exactly the HTML `marked.parse` returns, faster.

## Layout

- `parse.js` — the parser. A from-scratch fork of marked 18.1.3 (MIT,
  github.com/markedjs/marked, tag v18.1.3), dependency-free, no network, no
  I/O, no cache kept across calls: every `parse` starts from fresh state.
- `main.ts` — the harness driver: reads `cases.json` from
  `MAKEFUN_INPUT_DIR` (default `/input`), renders each case with `parse`,
  writes `html.json` to `MAKEFUN_OUTPUT_DIR` (default `/output`).

## How it is faster

1. **Position-indexed inline scan.** The inline pass walks the source by
   index and dispatches on the current character, instead of repeatedly
   slicing the remaining string and trying every inline rule. Plain text
   is consumed in one sweep up to the next character that can start a
   token (or a `www.`/scheme/email autolink, or the two spaces of a hard
   break); the exact text rule is the fallback whenever a sweep would be
   empty or starts at a token character.
2. **Lazy emphasis mask.** The mask that hides code spans, links and
   escapes from emphasis scanning is built only when a run actually
   contains `*`, `_` or `~`, and its closer scan starts at the first
   delimiter instead of at the start of the run; closer results are cached
   per run instead of re-scanned for every opener.
3. **Emphasis gates fixed.** The `isAsciiPunct` gate in the `~` rule is
   checked against the real next character, and a `_` that cannot open
   returns immediately instead of running the full emphasis machinery.
4. **Fast text run before URLs.** The plain-text sweep is tried before the
   extended-autolink rule, so ordinary prose never pays for the URL
   regexes.
5. **First-character block gate.** The block lexer tries a rule only when
   the first non-space character (within the allowed 0–3 space indent)
   can start it; tables and setext headings are gated on their second
   line instead, since their first line can start with anything.

## Correctness

Verified against marked 18.1.3 on the competition practice set (720/720
cases byte-identical) and on thousands of random documents compared
against the vendored marked.

## License

MIT. marked 18.1.3 is MIT, copyright markedjs; see `LICENSE` and
`vendor/marked/` for its licence and notice.
