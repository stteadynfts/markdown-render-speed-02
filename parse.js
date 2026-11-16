// parse.js — a fast drop-in for marked 18.1.3 (GFM defaults).
//
// Written from scratch for the markdown-render-speed-02 competition. The
// parsing rules follow marked 18.1.3 (MIT, github.com/markedjs/marked, tag
// v18.1.3): parse(markdown) returns exactly the HTML marked.parse returns
// with its defaults (gfm on, breaks off, pedantic off, async off). Only the
// GFM grammar is implemented, since those are the only options ever used
// here. Speed comes from: a position-indexed inline scan with a single
// "next interesting character" sweep per text run, char-code dispatch to the
// tokenizers that can match, a lazily built emphasis mask whose closer scan
// starts at the first delimiter, and a first-character gate in the block
// lexer so most block rules are never attempted. No memo or cache is kept
// across calls: every parse starts from fresh state.

/** Compose a regex from a pattern by substituting named fragments. */
function build(pattern, flags = '') {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  const api = {
    sub(name, val) {
      let v = typeof val === 'string' ? val : val.source;
      v = v.replace(/(^|[^\[])\^/g, '$1');
      src = src.replace(name, v);
      return api;
    },
    done() {
      return new RegExp(src, flags);
    },
  };
  return api;
}

/** Memoised per-indent regex factory (indent is clamped to 0..3). */
function indentCache(make) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    let re = cache[i];
    if (!re) {
      re = make(i);
      cache[i] = re;
    }
    return re;
  };
}

// ---------------------------------------------------------------------------
// Small shared patterns ("other" in marked's vocabulary)
// ---------------------------------------------------------------------------
const reCodeRemoveIndent = /^(?: {0,3}\t| {1,4})/gm;
const reOutputLinkReplace = /\\([\[\]])/g;
const reIndentCodeComp = /^(\s+)(?:```)/;
const reBeginningSpace = /^\s+/;
const reEndingHash = /#$/;
const reStartingSpace = /^ /;
const reEndingSpace = / $/;
const reEndingSpaceTab = /[ \t]$/;
const reNonSpace = /[^ ]/;
const reNewlineG = /\n/g;
const reTabG = /\t/g;
const reLeadingSpaceTab = /^[ \t]+/;
const reMultiSpaceG = /\s+/g;
const reBlankLine = /^[ \t]*$/;
const reDoubleBlank = /\n[ \t]*\n[ \t]*$/;
const reBlockquoteStart = /^ {0,3}>/;
const reBqSetext = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const reBqSetext2 = /^ {0,3}>[ \t]?/gm;
const reBqMarkerWs = /^( {0,3}>)([ \t]+)/gm;
const reListNest = /^ {1,4}(?=( {4})*[^ ])/g;
const reListTask = /^\[[ xX]\][ \t]+\S/;
const reListTaskRep = /^\[[ xX]\][ \t]+/;
const reListCheckbox = /\[[ xX]\]/;
const reAnyLine = /\n.*\n/;
const reHrefBrackets = /^<(.*)>$/;
const reTableDelim = /[:|]/;
const reTableAlignChars = /^\||\| *$/g;
const reTableRowBlank = /\n[ \t]*$/;
const reAlignRight = /^ *-+: *$/;
const reAlignCenter = /^ *:-+: *$/;
const reAlignLeft = /^ *:-+ *$/;
const reStartATag = /^<a /i;
const reEndATag = /^<\/a>/i;
const reStartPre = /^<(pre|code|kbd|script)(\s|>)/i;
const reEndPre = /^<\/(pre|code|kbd|script)(\s|>)/i;
const reStartAngle = /^</;
const reEndAngle = />$/;
const reAlphaNum = /[\p{L}\p{N}]/u;
const reNumRef = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const reNumRefOrAmp = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const reEscTest = /[&<>"']/;
const reEscRep = /[&<>"']/g;
const reEscTestNoEnc = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const reEscRepNoEnc = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const rePercentDecode = /%25/g;
const reFindPipe = /\|/g;
const reSplitPipe = / \|/;
const reSlashPipe = /\\\|/g;
const reCR = /\r\n|\r/g;
const reSpaceLine = /^ +$/gm;
const reNotSpaceStart = /^\S*/;
const reEndingNewline = /\n$/;

const listItemRe = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`);
const nextBulletRe = indentCache((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`));
const hrRe = indentCache((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRe = indentCache((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
const headingBeginRe = indentCache((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
const htmlBeginRe = indentCache((i) => new RegExp(`^ {0,${i}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRe = indentCache((i) => new RegExp(`^ {0,${i}}>`));

const TAG = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------
const reNewline = /^(?:[ \t]*(?:\n|$))+/;
const reBlockCode = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const reFences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const reHr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const reHeading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const reBullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const lheadingCore = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const reLheading = build(lheadingCore)
  .sub(/bull/g, reBullet)
  .sub(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .sub(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .sub(/blockquote/g, / {0,3}>/)
  .sub(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .sub(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .sub(/html/g, / {0,3}<[^\n>]+>\n/)
  .sub(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .done();
const reParagraphCore = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const reBlockText = /^[^\n]+/;
const reBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const reDef = build(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .sub('label', reBlockLabel)
  .sub('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .done();
const reList = build(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).sub(/bull/g, reBullet).done();
const reComment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const reBlockHtml = build(String.raw`^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:</\1>[^\n]*\n*|$)|comment[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|</?(tag)(?:[ \t]+|\n|/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|</[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))`, 'i')
  .sub('comment', reComment)
  .sub('tag', TAG)
  .sub('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .done();
const reTable = build(String.raw`^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)` + '\n*|$)')
  .sub('hr', reHr)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('blockquote', ' {0,3}>')
  .sub('code', '(?: {4}| {0,3}\t)[^\\n]')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', TAG)
  .done();
const reParagraph = build(reParagraphCore)
  .sub('hr', reHr)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('|lheading', '')
  .sub('table', reTable)
  .sub('blockquote', ' {0,3}>')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', TAG)
  .done();
const reBqParagraph = build(reParagraphCore)
  .sub('hr', reHr)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('|lheading', '')
  .sub('|table', '')
  .sub('blockquote', ' {0,3}>')
  .sub('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .sub('list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
  .sub('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', TAG)
  .done();
const reBlockquote = build(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).sub('paragraph', reBqParagraph).done();

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------
const reEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const reInlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const reBr = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;
const reDelLDelim = build(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').sub(/punct/g, PUNCT).done();
const delRDelimCore = String.raw`^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)`;
const reDelRDelim = build(delRDelimCore, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .done();
const reDel = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const emStrongLCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const reEmLDelim = build(emStrongLCore, 'u').sub(/punct/g, PUNCT_GFM).done();
const emStrongRAstCore = String.raw`^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\*+)(?=[\s]|$)|notPunctSpace(\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\*+)(?=notPunctSpace)|[\s](\*+)(?!\\*)(?=punct)|(?!\\*)punct(\*+)(?!\\*)(?=punct)|notPunctSpace(\*+)(?=notPunctSpace)`;
const reEmRDelimAst = build(emStrongRAstCore, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE_GFM)
  .sub(/punctSpace/g, PUNCT_SPACE_GFM)
  .sub(/punct/g, PUNCT_GFM)
  .done();
const emStrongRUndCore = String.raw`^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)`;
const reEmRDelimUnd = build(emStrongRUndCore, 'gu')
  .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .sub(/punctSpace/g, PUNCT_SPACE)
  .sub(/punct/g, PUNCT)
  .done();
const reAnyPunct = build(/\\(punct)/, 'gu').sub(/punct/g, PUNCT).done();
const reAnyPunctOutsideCode = build(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').sub(/punct/g, PUNCT).done();
const reAutolink = build(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .sub('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .sub('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .done();
const reInlineComment = build(reComment).sub('(?:-->|$)', '-->').done();
const reTag = build(String.raw`^comment|^</[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\s*/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>`)
  .sub('comment', reInlineComment)
  .sub('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .done();
const reLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const reInlineLabel = build(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).sub('brackets', reLabelBrackets).done();
const reLink = build(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .sub('label', reInlineLabel)
  .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .done();
const reReflink = build(/^!?\[(label)\]\[(ref)\]/).sub('label', reInlineLabel).sub('ref', reBlockLabel).done();
const reNolink = build(/^!?\[(ref)\](?:\[\])?/).sub('ref', reBlockLabel).done();
const reBoundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const reBoundedInlineLabel = build(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).sub('brackets', reLabelBrackets).done();
const reReflinkSearch = build('reflink|nolink(?!\\()', 'g')
  .sub('reflink', build(/^!?\[(label)\]\[(ref)\]/).sub('label', reBoundedInlineLabel).sub('ref', reBoundedBlockLabel).done())
  .sub('nolink', build(/^!?\[(ref)\](?:\[\])?/).sub('ref', reBoundedBlockLabel).done())
  .done();
const reBlockSkip = build(/link|precode-code|html/, 'g')
  .sub('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .sub('precode-', '(?<!`)()')
  .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .sub('html', /<(?! )[^<>]*?>/)
  .done();
const rePunct = build(/^((?![*_])punctSpace)/, 'u').sub(/punctSpace/g, PUNCT_SPACE).done();
const reExtEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const reExtEmailProto = build(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).sub(/email/g, reExtEmail).done();
const reUrl = build(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .sub('emailProtocol', reExtEmailProto)
  .sub('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .sub('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .done();
const reBackpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const reInlineText = build(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .sub('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
  .sub('wwwStart', '(?<![^\\s*_~(])www\\.')
  .done();

// The one sweep that finds where a plain-text run must end: the next
// character that can start an inline token, a www/scheme/email autolink, or
// the two spaces of a hard break. Anything else is consumed in one go.
const reNextSpecial = /[`*_~\[\\<!]|www\.|[a-zA-Z][a-zA-Z0-9+.-]{1,31}:\/\/|[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9]| {2,}\n/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s, encode) {
  if (encode) {
    if (reEscTest.test(s)) return s.replace(reEscRep, (c) => ESC_MAP[c]);
  } else if (reEscTestNoEnc.test(s)) {
    return s.replace(reEscRepNoEnc, (c) => ESC_MAP[c]);
  }
  return s;
}
function decodeRefs(text) {
  if (!reNumRef.test(text)) return text;
  return text.replace(reNumRefOrAmp, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(rePercentDecode, '%');
  } catch {
    return null;
  }
  return href;
}
function splitCells(row, count) {
  const cells = row
    .replace(reFindPipe, (m, off, str) => {
      let esc = false;
      let i = off;
      while (--i >= 0 && str[i] === '\\') esc = !esc;
      return esc ? '|' : ' |';
    })
    .split(reSplitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(reSlashPipe, '|');
  return cells;
}
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let n = 0;
  while (n < l) {
    const ch = str.charAt(l - n - 1);
    if (ch === c && !invert) n++;
    else if (ch !== c && invert) n++;
    else break;
  }
  return str.slice(0, l - n);
}
function trimBlankTail(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && reBlankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}
function normalizeLabel(label) {
  return label.trim().replace(reMultiSpaceG, ' ').toLowerCase().toUpperCase().toLowerCase();
}
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}
function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const add = 4 - (col % 4);
      out += ' '.repeat(add);
      col += add;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-parse state. Fresh for every parse() call; nothing is shared across
// calls, so a case can never see another case's links, queue or mask.
// ---------------------------------------------------------------------------
function newCtx() {
  return {
    links: Object.create(null),
    inlineQueue: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
}

// ASCII punctuation/symbols, exactly the ASCII members of [\p{P}\p{S}].
const ASCII_PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function isPunctChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) return ASCII_PUNCT.indexOf(ch) !== -1;
  return PUNCT.test(ch);
}
// Punctuation-or-space, the class the emphasis rules test the previous
// character against. `*` and `_` are not in it (the lookahead excludes them).
function isPunctSpaceChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 128) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') return true;
    return ASCII_PUNCT.indexOf(ch) !== -1 && ch !== '*' && ch !== '_';
  }
  return rePunct.test(ch);
}
function isAlnumChar(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// ---------------------------------------------------------------------------
// Emphasis mask: hides delimiters inside links, code spans, HTML and
// escapes so emStrong/del never see them, and records the last index where
// a `*` / `_` / `~` run can close. Built lazily, only when an emphasis or
// strikethrough opener is actually attempted, and only when the run holds
// something the mask could hide. The closer scan starts at the first
// delimiter instead of at 0: nothing before it can close.
// ---------------------------------------------------------------------------
function linkInText(ctx, text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(reBlockSkip)) {
    if (reLink.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(reReflinkSearch)) {
    const s = m[0];
    const refStart = s.lastIndexOf('[');
    if (s.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(s.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(ctx, s.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}
function maskSrc(ctx, src) {
  let out = src;
  if (ctx.links && src.includes('[')) {
    const maskReflink = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInText(ctx, text)) {
          return '[' + text.replace(reReflinkSearch, maskReflink) + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    out = out.replace(reReflinkSearch, maskReflink);
  }
  out = out.replace(reAnyPunctOutsideCode, (m0, code, punct) => {
    if (punct) return '+'.repeat(m0.length);
    if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return m0;
  });
  out = out.replace(reBlockSkip, (m0, _link, context) => {
    const off = context ? context.length : 0;
    return m0.slice(0, off) + '[' + 'a'.repeat(m0.length - off - 2) + ']';
  });
  return out;
}
function ensureMask(ctx, run) {
  if (run.built) return;
  run.built = true;
  const src = run.src;
  let masked = src;
  if (src.includes('[') || src.includes('`') || src.includes('<') || src.includes('\\')) {
    masked = maskSrc(ctx, src);
  }
  run.masked = masked;
  let first = -1;
  for (const c of ['*', '_', '~']) {
    const i = masked.indexOf(c);
    if (i !== -1 && (first === -1 || i < first)) first = i;
  }
  let star = -1, under = -1, tilde = -1;
  if (first !== -1) {
    const len = masked.length;
    for (let i = first; i < len; i++) {
      const ch = masked[i];
      if (ch !== '*' && ch !== '_' && ch !== '~') continue;
      const prev = i === 0 ? '\n' : masked[i - 1];
      let j = i + 1;
      while (j < len && masked[j] === ch) j++;
      if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
        if (ch === '~') tilde = i;
        else if (ch === '*') star = i;
        else under = i;
      }
      i = j - 1;
    }
  }
  run.star = star;
  run.under = under;
  run.tilde = tilde;
}

// ---------------------------------------------------------------------------
// Inline tokenizers. Each takes the full run string `s` and the index `pos`
// where the token would start, and returns a token object or undefined.
// ---------------------------------------------------------------------------
function tokEscape(s, pos) {
  const m = reEscape.exec(s.slice(pos));
  if (!m) return undefined;
  return { type: 'escape', raw: m[0], text: m[1] };
}
function tokTag(ctx, s, pos) {
  const m = reTag.exec(s.slice(pos));
  if (!m) return undefined;
  if (!ctx.inLink && reStartATag.test(m[0])) ctx.inLink = true;
  else if (ctx.inLink && reEndATag.test(m[0])) ctx.inLink = false;
  if (!ctx.inRawBlock && reStartPre.test(m[0])) ctx.inRawBlock = true;
  else if (ctx.inRawBlock && reEndPre.test(m[0])) ctx.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: ctx.inLink, inRawBlock: ctx.inRawBlock, block: false, text: m[0] };
}
function isLabelEndInsideToken(ctx, s, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = reInlineCode.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = s.slice(labelStart + i);
    const tok = reTag.exec(tokenSrc) || reAutolink.exec(tokenSrc);
    if (!tok) continue;
    if (tok[0].length > label.length - i) return true;
    i += tok[0].length - 1;
  }
  return false;
}
function outputLink(ctx, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(reOutputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = ctx.inLink;
  const outerEmitted = ctx.linkEmitted;
  const outerRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const tokens = inlineTokens(ctx, text, []);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerEmitted;
  ctx.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      ctx.inRawBlock = outerRawBlock;
      return undefined;
    }
    ctx.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}
function tokLink(ctx, s, pos) {
  if (ctx.linkParenPossible === false) return undefined;
  const rest = s.slice(pos);
  const cap = reLink.exec(rest);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(ctx, s, cap[1], pos + labelStart)) return undefined;
  const trimmedUrl = cap[2].trim();
  if (reStartAngle.test(trimmedUrl)) {
    if (!reEndAngle.test(trimmedUrl)) return undefined;
    const unesc = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - unesc.length) % 2 === 0) return undefined;
  } else {
    const lastParen = findClosingBracket(cap[2], '()');
    if (lastParen === -2) return undefined;
    if (lastParen > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParen;
      cap[2] = cap[2].substring(0, lastParen);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unesc = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unesc.length) % 2 === 0) return undefined;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (reStartAngle.test(href)) href = href.slice(1, -1);
  return outputLink(ctx, cap, {
    href: href ? href.replace(reAnyPunct, '$1') : href,
    title: title ? title.replace(reAnyPunct, '$1') : title,
  }, cap[0]);
}
function tokReflink(ctx, s, pos) {
  const rest = s.slice(pos);
  let cap = reReflink.exec(rest) || reNolink.exec(rest);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(ctx, s, cap[1], pos + labelStart)) return undefined;
  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const text = cap[0].charAt(0);
    return { type: 'text', raw: text, text };
  }
  return outputLink(ctx, cap, link, cap[0]);
}
function tokEmStrong(ctx, run, s, pos, prevChar) {
  // Cheap gate: the character after the delimiter run must not be
  // whitespace (or the run must not end here), or the opener regex cannot
  // match anything but a bare run, which the rule below rejects anyway.
  const delim0 = s[pos];
  let runLen = 0;
  while (s[pos + runLen] === delim0) runLen++;
  const after = s[pos + runLen];
  if (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '\r' || after === '\f') {
    // A bare run with nothing after it can never open: the opener regex
    // would match the run alone and the groups check rejects it.
    if (runLen === s.length - pos) return undefined;
    // Otherwise the next char is whitespace: the optional next-char group
    // cannot match, so groups are all empty and the opener is rejected.
    // (The regex could still match the bare run; the rule below rejects it.)
    return undefined;
  }
  ensureMask(ctx, run);
  const rest = s.slice(pos);
  const m = reEmLDelim.exec(rest);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
  const delim = m[0][0];
  const midRun = prevChar === delim;
  const masked = run.masked;
  const srcStart = pos;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || isPunctSpaceChar(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : isPunctSpaceChar(prevChar);
  if (m[4] && prevChar && reAlphaNum.test(prevChar)) return undefined;
  const nextChar = m[1] || m[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...m[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delim === '*' && !runPrevPunct));
    if (delim !== '*' && delim !== '_') return undefined;
    const endRe = delim === '*' ? reEmRDelimAst : reEmRDelimUnd;
    const lastIdx = delim === '*' ? run.star : run.under;
    const windowStart = pos + lLength;
    if (lastIdx < windowStart) return undefined;
    const maskedWindow = masked.slice(pos + lLength);
    const lastInWindow = lastIdx - windowStart;
    endRe.lastIndex = 0;
    let match;
    while ((match = endRe.exec(maskedWindow)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLen = [...match[0]][0].length;
      const raw = s.slice(pos, pos + lLength + match.index + lastCharLen + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(ctx, text, []) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(ctx, text, []) };
    }
  }
  return undefined;
}
function tokCodespan(s, pos) {
  const m = reInlineCode.exec(s.slice(pos));
  if (!m) return undefined;
  let text = m[2].replace(reNewlineG, ' ');
  const hasNonSpace = reNonSpace.test(text);
  const spaceBothEnds = reStartingSpace.test(text) && reEndingSpace.test(text);
  if (hasNonSpace && spaceBothEnds) text = text.substring(1, text.length - 1);
  return { type: 'codespan', raw: m[0], text };
}
function tokBr(s, pos) {
  const m = reBr.exec(s.slice(pos));
  if (!m) return undefined;
  return { type: 'br', raw: m[0] };
}
function tokDel(ctx, run, s, pos, prevChar) {
  // Fast gate, mirroring the left-delimiter rule: after one or two `~`
  // there must be a character that is neither whitespace nor `~`, and when
  // that character is punctuation the previous character must be absent or
  // punctuation as well. A `_` that cannot open returns false the same way.
  const c1 = s[pos + 1];
  let lLength;
  let next;
  if (c1 === '~') {
    lLength = 2;
    next = s[pos + 2];
  } else {
    lLength = 1;
    next = c1;
  }
  if (next === undefined || next === ' ' || next === '\t' || next === '\n' || next === '\r' || next === '\f' || next === '~') {
    return undefined;
  }
  if (isPunctChar(next) && prevChar && !isPunctChar(prevChar)) return undefined;
  ensureMask(ctx, run);
  const rest = s.slice(pos);
  const m = reDelLDelim.exec(rest);
  if (!m) return undefined;
  const nextChar = m[1] || '';
  if (!nextChar || !prevChar || isPunctChar(prevChar)) {
    const ll = [...m[0]].length - 1;
    let rDelim, rLength, delimTotal = ll;
    const lastIdx = run.tilde;
    const windowStart = pos + ll;
    if (lastIdx < windowStart) return undefined;
    const maskedWindow = run.masked.slice(pos + ll);
    const lastInWindow = lastIdx - windowStart;
    reDelRDelim.lastIndex = 0;
    let match;
    while ((match = reDelRDelim.exec(maskedWindow)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== ll) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLen = [...match[0]][0].length;
      const raw = s.slice(pos, pos + ll + match.index + lastCharLen + rLength);
      const text = raw.slice(ll, -ll);
      return { type: 'del', raw, text, tokens: inlineTokens(ctx, text, []) };
    }
  }
  return undefined;
}
function tokAutolink(s, pos) {
  const m = reAutolink.exec(s.slice(pos));
  if (!m) return undefined;
  let text, href;
  if (m[2] === '@') {
    text = m[1];
    href = 'mailto:' + text;
  } else {
    text = m[1];
    href = text;
  }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}
function tokUrl(s, pos) {
  const m = reUrl.exec(s.slice(pos));
  if (!m) return undefined;
  let text, href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let prev0;
    do {
      prev0 = m[0];
      m[0] = reBackpedal.exec(m[0])?.[0] ?? '';
    } while (prev0 !== m[0]);
    text = m[0];
    href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}
function tokInlineText(ctx, s, pos) {
  const m = reInlineText.exec(s.slice(pos));
  if (!m) return undefined;
  const inRaw = ctx.inRawBlock;
  return { type: 'text', raw: m[0], text: inRaw ? m[0] : decodeRefs(m[0]), escaped: inRaw };
}

// ---------------------------------------------------------------------------
// Inline pass: position-indexed scan with char dispatch. The plain-text
// fast run consumes a whole stretch in one sweep (see reNextSpecial); the
// exact text regex is the fallback whenever a run would be empty or starts
// at a token character, so the output is identical to marked's.
// ---------------------------------------------------------------------------
function mergeText(tokens, raw, text, escaped) {
  const last = tokens.at(-1);
  if (last && last.type === 'text') {
    last.raw += raw;
    last.text += text;
  } else {
    tokens.push({ type: 'text', raw, text, escaped });
  }
}
function inlineTokens(ctx, src, tokens) {
  const run = { src, masked: null, star: -1, under: -1, tilde: -1, built: false };
  const prevLPP = ctx.linkParenPossible;
  ctx.linkParenPossible = prevLPP && src.includes(')');
  try {
    tokenizeInline(ctx, run, src, tokens);
  } finally {
    ctx.linkParenPossible = prevLPP;
  }
  return tokens;
}
function tokenizeInline(ctx, run, src, tokens) {
  const len = src.length;
  let pos = 0;
  let prevChar = '';
  let keepPrev = false;
  while (pos < len) {
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    const ch = src[pos];
    let tok;
    if (ch === '\\') {
      tok = tokEscape(src, pos) || tokBr(src, pos);
    } else if (ch === '<') {
      tok = tokTag(ctx, src, pos) || tokAutolink(src, pos);
    } else if (ch === '[' || ch === '!') {
      tok = tokLink(ctx, src, pos) || tokReflink(ctx, src, pos);
    } else if (ch === '*' || ch === '_') {
      tok = tokEmStrong(ctx, run, src, pos, prevChar);
    } else if (ch === '`') {
      tok = tokCodespan(src, pos);
    } else if (ch === '~') {
      tok = tokDel(ctx, run, src, pos, prevChar);
    } else if (ch === ' ' || ch === '\n') {
      tok = tokBr(src, pos);
    }
    if (tok) {
      pos += tok.raw.length;
      if (tok.type === 'text') {
        // Only reflink returns a text token here; marked merges it but
        // does not let it set prevChar, so neither do we.
        mergeText(tokens, tok.raw, tok.text, tok.escaped);
      }
      continue;
    }
    // Extended autolink, only outside links and only where one can start.
    if (!ctx.inLink && isAlnumChar(ch)) {
      tok = tokUrl(src, pos);
      if (tok) {
        pos += tok.raw.length;
        tokens.push(tok);
        continue;
      }
    }
    // Text. A run that starts at a token character, or a sweep that lands
    // back on its start, goes through the exact text rule instead.
    if (ch === '*' || ch === '_' || ch === '~' || ch === '`' || ch === '[' || ch === '!' || ch === '<' || ch === '\\') {
      tok = tokInlineText(ctx, src, pos);
      if (!tok) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
      pos += tok.raw.length;
      mergeText(tokens, tok.raw, tok.text, tok.escaped);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      keepPrev = true;
      continue;
    }
    reNextSpecial.lastIndex = pos;
    const hit = reNextSpecial.exec(src);
    const end = hit ? hit.index : len;
    if (end <= pos) {
      tok = tokInlineText(ctx, src, pos);
      if (!tok) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
      pos += tok.raw.length;
      mergeText(tokens, tok.raw, tok.text, tok.escaped);
      if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
      keepPrev = true;
      continue;
    }
    const raw = src.slice(pos, end);
    const inRaw = ctx.inRawBlock;
    mergeText(tokens, raw, inRaw ? raw : decodeRefs(raw), inRaw);
    if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
    keepPrev = true;
    pos = end;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Block tokenizers. Each takes the remaining source `rest` and returns a
// token object or undefined. `ctx` carries the links table and the inline
// queue, exactly as in marked.
// ---------------------------------------------------------------------------
function indentCompensation(raw, text) {
  const m = raw.match(reIndentCodeComp);
  if (m === null) return text;
  const ind = m[1];
  return text.split('\n').map((line) => {
    const n = line.match(reBeginningSpace);
    if (n === null) return line;
    return line.slice(Math.min(n[0].length, ind.length));
  }).join('\n');
}
function tokSpace(rest) {
  const cap = reNewline.exec(rest);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
  return undefined;
}
function tokCode(rest) {
  const cap = reBlockCode.exec(rest);
  if (!cap) return undefined;
  const raw = trimBlankTail(cap[0]);
  return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(reCodeRemoveIndent, '') };
}
function tokFences(rest) {
  const cap = reFences.exec(rest);
  if (!cap) return undefined;
  return {
    type: 'code',
    raw: cap[0],
    lang: cap[2] ? cap[2].trim().replace(reAnyPunct, '$1') : cap[2],
    text: indentCompensation(cap[0], cap[3] || ''),
  };
}
function tokHeading(ctx, rest) {
  const cap = reHeading.exec(rest);
  if (!cap) return undefined;
  let text = cap[2].trim();
  if (reEndingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || reEndingSpaceTab.test(trimmed)) text = trimmed.trim();
  }
  return { type: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text, tokens: queueInline(ctx, text) };
}
function tokHr(rest) {
  const cap = reHr.exec(rest);
  if (!cap) return undefined;
  return { type: 'hr', raw: rtrim(cap[0], '\n') };
}
function queueInline(ctx, text) {
  const tokens = [];
  ctx.inlineQueue.push({ src: text, tokens });
  return tokens;
}
function tokBlockquote(ctx, rest) {
  const cap = reBlockquote.exec(rest);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBq = false;
    const cur = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (reBlockquoteStart.test(lines[i])) {
        cur.push(lines[i]);
        inBq = true;
      } else if (!inBq) {
        cur.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const curRaw = cur.join('\n');
    const curText = curRaw
      .replace(reBqMarkerWs, (g, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(reBqSetext, '\n    $1')
      .replace(reBqSetext2, '');
    raw = raw ? raw + '\n' + curRaw : curRaw;
    text = text ? text + '\n' + curText : curText;
    const top = ctx.top;
    ctx.top = true;
    blockTokens(ctx, curText, tokens, true);
    ctx.top = top;
    if (lines.length === 0) break;
    const last = tokens.at(-1);
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') {
      break;
    } else if (last?.type === 'blockquote') {
      const oldTok = last;
      const cont = lines.join('\n');
      const newText = oldTok.raw + '\n' + cont.replace(reBqSetext2, '');
      const newTok = tokBlockquote(ctx, newText);
      tokens[tokens.length - 1] = newTok;
      const leftover = newText.substring(newTok.raw.length).replace(/^\n/, '');
      const leftCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftCount ? lines.slice(0, -leftCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - oldTok.text.length) + newTok.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && reBlockquoteStart.test(lines[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const oldTok = last;
      const newText = oldTok.raw + '\n' + lines.join('\n');
      const newTok = tokList(ctx, newText);
      tokens[tokens.length - 1] = newTok;
      const consumedCount = newTok.raw.length > oldTok.raw.length
        ? newText.slice(oldTok.raw.length + 1, newTok.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

function tokList(ctx, src) {
  let cap = reList.exec(src);
  if (!cap) return undefined;
  const listSrc = src;
  let s = src;
  const taken = () => listSrc.length - s.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = listItemRe(bull);
  let endsWithBlankLine = false;
  while (s) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(s))) break;
    if (reHr.test(s)) break; // End list if bullet was actually HR
    const itemStart = taken();
    s = s.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(reLeadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = s.split('\n', 1)[0];
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(reNonSpace);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && reBlankLine.test(nextLine)) {
      s = s.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = nextBulletRe(indent);
      const hrRegex = hrRe(indent);
      const fencesBeginRegex = fencesBeginRe(indent);
      const headingBeginRegex = headingBeginRe(indent);
      const htmlBeginRegex = htmlBeginRe(indent);
      const blockquoteBeginRegex = blockquoteBeginRe(indent);
      while (s) {
        const rawLine = s.split('\n', 1)[0];
        let nextLineWithoutTabs;
        nextLine = rawLine;
        nextLineWithoutTabs = nextLine.replace(reLeadingSpaceTab, (ws) => expandTabs(ws));
        if (fencesBeginRegex.test(nextLine)) break;
        if (headingBeginRegex.test(nextLine)) break;
        if (htmlBeginRegex.test(nextLine)) break;
        if (blockquoteBeginRegex.test(nextLine)) break;
        if (nextBulletRegex.test(nextLine)) break;
        if (hrRegex.test(nextLine)) break;
        if (nextLineWithoutTabs.search(reNonSpace) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (line.replace(reTabG, '    ').search(reNonSpace) >= 4) break;
          if (fencesBeginRegex.test(line)) break;
          if (headingBeginRegex.test(line)) break;
          if (htmlBeginRegex.test(line)) break;
          if (hrRegex.test(line)) break;
          // A lazy continuation can look like a setext underline after list
          // indentation is removed. Keep it in the paragraph.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && reLheading.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = !nextLine.trim();
        s = s.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, taken());
    if (!list.loose) {
      if (endsWithBlankLine) {
        list.loose = true;
      } else if (reDoubleBlank.test(raw)) {
        endsWithBlankLine = true;
      }
    }
    list.items.push({
      type: 'list_item',
      raw,
      task: !!reListTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return undefined;
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = blockTokens(ctx, item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => reAnyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
      item.text = item.text.replace(reListTaskRep, '');
      itemToken.raw = itemToken.raw.replace(reListTaskRep, '');
      itemToken.text = itemToken.text.replace(reListTaskRep, '');
      for (let i = ctx.inlineQueue.length - 1; i >= 0; i--) {
        if (reListTask.test(ctx.inlineQueue[i].src)) {
          ctx.inlineQueue[i].src = ctx.inlineQueue[i].src.replace(reListTaskRep, '');
          break;
        }
      }
      const taskRaw = reListCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkboxToken = {
          type: 'checkbox',
          raw: taskRaw[0] + ' ',
          checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkboxToken.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
            item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkboxToken);
          } else {
            item.tokens.unshift({
              type: 'paragraph',
              raw: checkboxToken.raw,
              text: checkboxToken.raw,
              tokens: [checkboxToken],
            });
          }
        } else {
          item.tokens.unshift(checkboxToken);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }
  return list;
}
function tokHtml(rest) {
  const cap = reBlockHtml.exec(rest);
  if (!cap) return undefined;
  const raw = trimBlankTail(cap[0]);
  return {
    type: 'html',
    block: true,
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}
function tokDef(ctx, rest) {
  const cap = reDef.exec(rest);
  if (!cap) return undefined;
  if (!reStartAngle.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return undefined;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(reHrefBrackets, '$1').replace(reAnyPunct, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(reAnyPunct, '$1') : cap[3];
  return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
}
function tokTable(ctx, rest) {
  const cap = reTable.exec(rest);
  if (!cap) return undefined;
  if (!reTableDelim.test(cap[2])) return undefined;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(reTableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(reTableRowBlank, '').split('\n') : [];
  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return undefined;
  for (const align of aligns) {
    if (reAlignRight.test(align)) item.align.push('right');
    else if (reAlignCenter.test(align)) item.align.push('center');
    else if (reAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], tokens: queueInline(ctx, headers[i]), header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell, tokens: queueInline(ctx, cell), header: false, align: item.align[i],
    })));
  }
  return item;
}
function tokLheading(ctx, rest) {
  const cap = reLheading.exec(rest);
  if (!cap) return undefined;
  const text = cap[1].trim();
  return {
    type: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
    tokens: queueInline(ctx, text),
  };
}
function tokParagraph(ctx, rest) {
  const cap = reParagraph.exec(rest);
  if (!cap) return undefined;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  return { type: 'paragraph', raw: cap[0], text, tokens: queueInline(ctx, text) };
}
function tokText(ctx, rest) {
  const cap = reBlockText.exec(rest);
  if (!cap) return undefined;
  return { type: 'text', raw: cap[0], text: cap[0], tokens: queueInline(ctx, cap[0]) };
}

// ---------------------------------------------------------------------------
// Block lexer. A first-character gate keeps most block rules from ever
// running: a rule is attempted only when the first non-space character
// (within the allowed 0-3 space indent) can start it. Table and setext
// heading are gated on their second line instead, since their first line
// can start with anything.
// ---------------------------------------------------------------------------
function hasTableDelim(rest) {
  const nl = rest.indexOf('\n');
  if (nl === -1) return false;
  const nl2 = rest.indexOf('\n', nl + 1);
  const line2 = nl2 === -1 ? rest.slice(nl + 1) : rest.slice(nl + 1, nl2);
  let i = 0;
  while (i < 3 && line2[i] === ' ') i++;
  const body = line2.slice(i);
  return body.includes('-') && (body.includes('|') || body.includes(':'));
}
function hasSetextUnderline(rest) {
  const blankAt = rest.search(/\n[ \t]*\n/);
  const win = blankAt === -1 ? rest : rest.slice(0, blankAt);
  return /\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/.test(win);
}
function blockTokens(ctx, src, tokens = [], lastParaClipped = false) {
  let pos = 0;
  const len = src.length;
  let guard = Infinity;
  let clipped = lastParaClipped;
  while (pos < len) {
    if (len - pos < guard) guard = len - pos;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    const rest = src.slice(pos);
    let sp = 0;
    while (sp < 3 && rest[sp] === ' ') sp++;
    const first = rest[sp];
    let tok = tokSpace(rest);
    if (tok) {
      pos += tok.raw.length;
      const last = tokens.at(-1);
      if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    if (rest.startsWith('    ') || rest[sp] === '\t') {
      tok = tokCode(rest);
      if (tok) {
        pos += tok.raw.length;
        const last = tokens.at(-1);
        if (last?.type === 'paragraph' || last?.type === 'text') {
          // An indented code block cannot interrupt a paragraph.
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          ctx.inlineQueue.at(-1).src = last.text;
        } else {
          tokens.push(tok);
        }
        continue;
      }
    }
    if (first === '`' || first === '~') {
      tok = tokFences(rest);
      if (tok) { pos += tok.raw.length; tokens.push(tok); continue; }
    }
    if (first === '#') {
      tok = tokHeading(ctx, rest);
      if (tok) { pos += tok.raw.length; tokens.push(tok); continue; }
    }
    if (first === '-' || first === '_' || first === '*') {
      tok = tokHr(rest);
      if (tok) { pos += tok.raw.length; tokens.push(tok); continue; }
    }
    if (first === '>') {
      tok = tokBlockquote(ctx, rest);
      if (tok) { pos += tok.raw.length; tokens.push(tok); continue; }
    }
    if (first === '*' || first === '+' || first === '-' || (first >= '0' && first <= '9')) {
      tok = tokList(ctx, rest);
      if (tok) { pos += tok.raw.length; tokens.push(tok); continue; }
    }
    if (first === '<') {
      tok = tokHtml(rest);
      if (tok) { pos += tok.raw.length; tokens.push(tok); continue; }
    }
    if (first === '[') {
      tok = tokDef(ctx, rest);
      if (tok) {
        pos += tok.raw.length;
        const last = tokens.at(-1);
        if (last?.type === 'paragraph' || last?.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          ctx.inlineQueue.at(-1).src = last.text;
        } else {
          if (tok.tag && !ctx.links[tok.tag]) ctx.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
    }
    if (hasTableDelim(rest)) {
      tok = tokTable(ctx, rest);
      if (tok) { pos += tok.raw.length; tokens.push(tok); continue; }
    }
    if (hasSetextUnderline(rest)) {
      tok = tokLheading(ctx, rest);
      if (tok) { pos += tok.raw.length; tokens.push(tok); continue; }
    }
    if (ctx.top) {
      tok = tokParagraph(ctx, rest);
      if (tok) {
        pos += tok.raw.length;
        const last = tokens.at(-1);
        if (clipped && last?.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          ctx.inlineQueue.pop();
          ctx.inlineQueue.at(-1).src = last.text;
        } else {
          tokens.push(tok);
        }
        clipped = false;
        continue;
      }
    }
    tok = tokText(ctx, rest);
    if (tok) {
      pos += tok.raw.length;
      const last = tokens.at(-1);
      if (last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        ctx.inlineQueue.pop();
        ctx.inlineQueue.at(-1).src = last.text;
      } else {
        tokens.push(tok);
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  ctx.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Renderer: a direct port of marked's default Renderer + TextRenderer.
// renderTokens handles block tokens, renderInline handles span tokens;
// textOnly=true selects the plain-text renderer (image alt text).
// ---------------------------------------------------------------------------
function tablecell(cellToken) {
  const content = renderInline(cellToken.tokens);
  const type = cellToken.header ? 'th' : 'td';
  const tag = cellToken.align ? `<${type} align="${cellToken.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}
function renderTokens(tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${token.depth}>${renderInline(token.tokens)}</h${token.depth}>\n`; break;
      case 'code': {
        const langString = (token.lang || '').match(reNotSpaceStart)?.[0];
        const code = token.text ? token.text.replace(reEndingNewline, '') + '\n' : '';
        if (!langString) {
          out += '<pre><code>' + (token.escaped ? code : escapeHtml(code, true)) + '</code></pre>\n';
        } else {
          out += '<pre><code class="language-' + escapeHtml(langString) + '">' + (token.escaped ? code : escapeHtml(code, true)) + '</code></pre>\n';
        }
        break;
      }
      case 'table': {
        let header = '';
        let cell = '';
        for (let j = 0; j < token.header.length; j++) cell += tablecell(token.header[j]);
        header += `<tr>\n${cell}</tr>\n`;
        let body = '';
        for (let j = 0; j < token.rows.length; j++) {
          const row = token.rows[j];
          cell = '';
          for (let k = 0; k < row.length; k++) cell += tablecell(row[k]);
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote': out += `<blockquote>\n${renderTokens(token.tokens)}</blockquote>\n`; break;
      case 'list': {
        const ordered = token.ordered;
        const start = token.start;
        let body = '';
        for (let j = 0; j < token.items.length; j++) {
          body += `<li>${renderTokens(token.items[j].tokens)}</li>\n`;
        }
        const type = ordered ? 'ol' : 'ul';
        const startAttr = (ordered && start !== 1) ? (' start="' + start + '"') : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox': out += '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'html': out += token.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(token.tokens)}</p>\n`; break;
      case 'text': out += renderInline(token.tokens); break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}
function renderInline(tokens, textOnly = false) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'escape': out += textOnly ? token.text : escapeHtml(token.text); break;
      case 'html': out += token.text; break;
      case 'link': {
        if (textOnly) {
          out += token.tokens ? renderInline(token.tokens, true) : token.text;
          break;
        }
        const parsedText = token.autolink ? escapeHtml(token.text, true) : renderInline(token.tokens);
        const cleanHref = cleanUrl(token.href);
        if (cleanHref === null) { out += parsedText; break; }
        const href = escapeHtml(cleanHref, token.autolink);
        let o = '<a href="' + href + '"';
        if (token.title) o += ' title="' + escapeHtml(token.title) + '"';
        o += '>' + parsedText + '</a>';
        out += o;
        break;
      }
      case 'image': {
        if (textOnly) {
          out += token.tokens ? renderInline(token.tokens, true) : token.text;
          break;
        }
        let text = token.text;
        if (token.tokens) text = renderInline(token.tokens, true);
        const cleanHref = cleanUrl(token.href);
        if (cleanHref === null) { out += escapeHtml(text); break; }
        let o = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(text)}"`;
        if (token.title) o += ` title="${escapeHtml(token.title)}"`;
        o += '>';
        out += o;
        break;
      }
      case 'checkbox': out += textOnly ? token.raw : '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'strong': out += textOnly ? (token.tokens ? renderInline(token.tokens, true) : token.text) : `<strong>${renderInline(token.tokens)}</strong>`; break;
      case 'em': out += textOnly ? (token.tokens ? renderInline(token.tokens, true) : token.text) : `<em>${renderInline(token.tokens)}</em>`; break;
      case 'codespan': out += textOnly ? token.text : `<code>${escapeHtml(token.text, true)}</code>`; break;
      case 'br': out += textOnly ? '' : '<br>'; break;
      case 'del': out += textOnly ? (token.tokens ? renderInline(token.tokens, true) : token.text) : `<del>${renderInline(token.tokens)}</del>`; break;
      case 'text': {
        if (textOnly) { out += token.text; break; }
        out += ('tokens' in token && token.tokens)
          ? renderInline(token.tokens)
          : (('escaped' in token && token.escaped) ? token.text : escapeHtml(token.text));
        break;
      }
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point: marked.parse(src) with the GFM defaults.
// ---------------------------------------------------------------------------
export function parse(src) {
  src = src.replace(reCR, '\n');
  const ctx = {
    top: true,
    inLink: false,
    inRawBlock: false,
    linkParenPossible: false,
    links: {},
    inlineQueue: [],
  };
  const tokens = blockTokens(ctx, src, [], false);
  for (let i = 0; i < ctx.inlineQueue.length; i++) {
    const next = ctx.inlineQueue[i];
    // An inline <pre>, <code>, <kbd> or <script> left open ends with the
    // block holding it; carried over, it would stop every later block's
    // text from being escaped.
    ctx.inRawBlock = false;
    inlineTokens(ctx, next.src, next.tokens);
  }
  ctx.inlineQueue = [];
  return renderTokens(tokens);
}
