/**
 * Syntax highlighting for code blocks, from highlight.js.
 *
 * Only the core and a curated set of eighteen common languages are registered,
 * rather than the full set of nearly two hundred, which would be most of a
 * megabyte for languages hardly anyone posts. This module is only ever reached
 * through the dynamic import in code-highlight.ts, so it lands in a chunk of its
 * own that a session showing no code block never downloads.
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// Each definition brings its usual aliases with it: js, ts, py, sh, html, yml,
// rs, cs, c++, md and so on all resolve without being listed here.
const LANGUAGES = { bash, c, cpp, csharp, css, diff, go, java, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml };
for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);

/**
 * Above this many characters, highlighting a fenced block synchronously on the
 * main thread would stall the UI for longer than the color is worth: the library
 * is roughly linear in the input but with a large enough constant to matter at
 * this size. A longer block is left plain, which the caller already handles.
 */
const maxHighlightLength = 20_000;

/**
 * The code as highlighted HTML, or null for a language that is not registered
 * or a block too long to highlight, which the caller shows as plain text.
 *
 * The HTML is safe to put on the page as it is. `highlight()` builds its output
 * from the source as text: every stretch of the code it emits goes through the
 * library's own HTML escaping (`&`, `<`, `>`, `"` and `'`), and the only markup
 * it adds is its own `<span class="hljs-…">` around those escaped stretches. The
 * code itself can therefore never become markup, whatever it contains; the text
 * smoke test holds the library to that. (The warnings highlight.js gives about
 * unescaped HTML concern `highlightElement`, which reads an element already on
 * the page, and is not used here.)
 */
export function highlight(code: string, language: string): string | null {
  if (code.length > maxHighlightLength) return null;
  if (!hljs.getLanguage(language)) return null;
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}
