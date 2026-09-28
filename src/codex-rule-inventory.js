'use strict';

// This is a deliberately restricted reader, never a Starlark evaluator. A
// partial inventory cannot safely support removal, so every declaration and
// every byte outside declarations must belong to the supported literal subset.
// Inline examples are retained as literals, not executed here. Codex's real
// policy checker must still validate a file before any policy write.
const FIELDS = new Set(['pattern', 'decision', 'justification', 'match', 'not_match']);
const DECISIONS = new Set(['allow', 'prompt', 'forbidden']);
const SIMPLE_ESCAPES = Object.freeze({
  '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f',
  n: '\n', r: '\r', t: '\t', v: '\v',
});

function validPattern(pattern) {
  return Array.isArray(pattern) && pattern.length > 0 && pattern.every((position) =>
    typeof position === 'string' || (Array.isArray(position) && position.length > 0 &&
      position.every((token) => typeof token === 'string')));
}

class LiteralReader {
  constructor(text) {
    this.text = text;
    this.at = 0;
  }

  fail(message) {
    throw new SyntaxError(`Unsupported Codex policy at offset ${this.at}: ${message}`);
  }

  trivia() {
    const start = this.at;
    while (this.at < this.text.length) {
      const char = this.text[this.at];
      if (char === '#') {
        while (this.at < this.text.length && !/[\r\n]/.test(this.text[this.at])) this.at++;
      } else if (/[ \r\n]/.test(char)) this.at++;
      else break;
    }
    return /[\r\n]/.test(this.text.slice(start, this.at));
  }

  take(char) {
    this.trivia();
    if (this.text[this.at] !== char) this.fail(`expected '${char}'`);
    this.at++;
  }

  identifier() {
    this.trivia();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.at));
    if (!match) this.fail('expected a literal named field or prefix_rule declaration');
    this.at += match[0].length;
    return match[0];
  }

  string() {
    this.trivia();
    const quote = this.text[this.at];
    if (quote !== '"' && quote !== "'") this.fail('expected a quoted string literal');
    if (this.text.slice(this.at, this.at + 3) === quote.repeat(3)) {
      this.fail('triple-quoted strings are read-only');
    }
    this.at++;
    let result = '';
    while (this.at < this.text.length) {
      const char = this.text[this.at++];
      if (char === quote) return result;
      if (char === '\r' || char === '\n') this.fail('unescaped newline in string literal');
      if (char !== '\\') {
        if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) {
          this.fail('unescaped control character in string literal');
        }
        result += char;
        continue;
      }
      if (this.at === this.text.length) this.fail('unterminated escape');
      const escape = this.text[this.at++];
      if (Object.hasOwn(SIMPLE_ESCAPES, escape)) {
        result += SIMPLE_ESCAPES[escape];
      } else if (escape === '\n') {
        // Starlark's escaped physical newline contributes no string character.
      } else if (escape === '\r' && this.text[this.at] === '\n') {
        this.at++;
      } else if (escape === 'x' || escape === 'u' || escape === 'U') {
        const count = escape === 'x' ? 2 : escape === 'u' ? 4 : 8;
        const digits = this.text.slice(this.at, this.at + count);
        if (digits.length !== count || !/^[0-9a-fA-F]+$/.test(digits)) {
          this.fail('invalid hexadecimal string escape');
        }
        const point = parseInt(digits, 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
          this.fail('escape is not a Unicode scalar value');
        }
        result += String.fromCodePoint(point);
        this.at += count;
      } else if (/[0-7]/.test(escape)) {
        const tail = /^[0-7]{0,2}/.exec(this.text.slice(this.at))[0];
        const point = parseInt(escape + tail, 8);
        result += String.fromCodePoint(point);
        this.at += tail.length;
      } else this.fail('unknown string escape');
    }
    this.fail('unterminated string literal');
  }

  array(nested = false) {
    this.take('[');
    const values = [];
    this.trivia();
    while (this.text[this.at] !== ']') {
      values.push(nested && this.text[this.at] === '[' ? this.array(false) : this.string());
      this.trivia();
      if (this.text[this.at] === ']') break;
      this.take(',');
      this.trivia();
    }
    this.take(']');
    return values;
  }

  rule() {
    const start = this.at;
    if (this.identifier() !== 'prefix_rule') this.fail('only top-level prefix_rule calls are supported');
    if (this.trivia()) this.fail('newline before prefix_rule call arguments');
    this.take('(');
    const values = {};
    this.trivia();
    while (this.text[this.at] !== ')') {
      const name = this.identifier();
      if (!FIELDS.has(name)) this.fail(`unknown prefix_rule field '${name}'`);
      if (Object.hasOwn(values, name)) this.fail(`duplicate prefix_rule field '${name}'`);
      this.take('=');
      values[name] = name === 'decision' || name === 'justification'
        ? this.string() : this.array(true);
      this.trivia();
      if (this.text[this.at] === ')') break;
      this.take(',');
      this.trivia();
    }
    this.take(')');
    if (!validPattern(values.pattern)) this.fail('pattern must be a nonempty array of strings or nonempty string alternatives');
    if (!DECISIONS.has(values.decision)) this.fail('decision must explicitly be allow, prompt or forbidden');
    if (values.justification === '') this.fail('justification must not be empty');
    for (const name of ['match', 'not_match']) {
      if (values[name]?.some((entry) => Array.isArray(entry) && entry.length === 0)) {
        this.fail(`${name} argv examples must not be empty`);
      }
    }
    return { start, end: this.at, ...values };
  }
}

/** start/end are exact UTF-16 string offsets, suitable for String.slice. */
function parseCodexRules(text) {
  if (typeof text !== 'string') return { supported: false, rules: [], reason: 'Codex policy must be text' };
  const reader = new LiteralReader(text);
  try {
    if (/\r(?!\n)/.test(text)) reader.fail('bare carriage returns are read-only; use LF or CRLF');
    const rules = [];
    reader.trivia();
    while (reader.at < text.length) {
      const lineStart = Math.max(text.lastIndexOf('\n', reader.at - 1), text.lastIndexOf('\r', reader.at - 1)) + 1;
      const before = text.slice(lineStart, reader.at);
      if (/^[ \t\f]+$/.test(before)) reader.fail('indented top-level statements are read-only');
      rules.push(reader.rule());
      const newline = reader.trivia();
      if (reader.at < text.length && !newline) reader.fail('top-level declarations must be separated by a newline');
    }
    return { supported: true, rules };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { supported: false, rules: [], reason: error.message };
  }
}

/** Remove only complete declarations from a freshly supported file. */
function removeRuleSpans(text, rules) {
  const parsed = parseCodexRules(text);
  if (!parsed.supported) throw new Error(`Refusing to remove rules: ${parsed.reason}`);
  if (!Array.isArray(rules)) throw new TypeError('Selected Codex rules must be an array');
  const selected = [...rules].sort((a, b) => (a?.start ?? -1) - (b?.start ?? -1));
  let lastEnd = 0;
  const pieces = [];
  for (const rule of selected) {
    const current = parsed.rules.find((entry) => entry.start === rule?.start && entry.end === rule?.end);
    if (!current || current.start < lastEnd || [...FIELDS].some((name) =>
      JSON.stringify(rule[name]) !== JSON.stringify(current[name]))) {
      throw new Error('Refusing to remove stale, overlapping or non-declaration Codex rule spans');
    }
    pieces.push(text.slice(lastEnd, current.start));
    lastEnd = current.end;
  }
  pieces.push(text.slice(lastEnd));
  return pieces.join('');
}

/** True when at least one argv sequence can match both prefixes. */
function patternsOverlap(a, b) {
  if (!validPattern(a) || !validPattern(b)) throw new TypeError('Codex prefixes must be nonempty literal patterns');
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const left = Array.isArray(a[index]) ? a[index] : [a[index]];
    const right = Array.isArray(b[index]) ? b[index] : [b[index]];
    if (!left.some((token) => right.includes(token))) return false;
  }
  return true;
}

module.exports = { parseCodexRules, removeRuleSpans, patternsOverlap };
