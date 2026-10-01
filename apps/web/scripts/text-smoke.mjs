// Focused checks for the client's message plumbing: the text parser for markdown,
// links, emoji and mentions, and the merge that catches up after being away.
//
// Run with: npm run smoke:text
import { parseMessage } from '../src/lib/message-text.ts';
import { mergeLatest } from '../src/lib/messages.ts';

let failures = 0;
function check(name, condition) {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

const noEmoji = new Map();
const noMention = () => undefined;

/** Every inline segment of a message, skipping code blocks. */
function inline(text, emoji = noEmoji, mention = noMention) {
  return parseMessage(text, emoji, mention).flatMap((block) => (block.type === 'code' ? [] : block.segments));
}

/** The concatenated visible text, ignoring styling. */
function plain(text, emoji = noEmoji, mention = noMention) {
  return inline(text, emoji, mention)
    .map((segment) => segment.value)
    .join('');
}

function parse(text, emoji = noEmoji, mention = noMention) {
  return parseMessage(text, emoji, mention);
}

const styled = (text, style, value) =>
  inline(text).some((segment) => segment.styles?.[style] === true && segment.value === value);

// --- Blocks ---
const single = parse('hello world');
check('plain text is a single paragraph', single.length === 1 && single[0].type === 'paragraph');
check('plain text round-trips', plain('hello world') === 'hello world');

const fenced = parse('```js\nconst a = 1;\n```');
check(
  'a fenced block becomes code',
  fenced.length === 1 && fenced[0].type === 'code' && fenced[0].text === 'const a = 1;' && fenced[0].language === 'js',
);
check('text around a fence stays in paragraphs', parse('before\n```\nx\n```\nafter').length === 3);

check('a level 1 header is detected', parse('# Title')[0].type === 'header' && parse('# Title')[0].level === 1);
check('a level 2 header is detected', parse('## Title')[0].level === 2);

const quote = parse('> one\n> two');
check('consecutive quote lines merge', quote.length === 1 && quote[0].type === 'quote');
check('a quote drops the markers', quote[0].segments.map((segment) => segment.value).join('') === 'one\ntwo');

// --- Inline emphasis ---
check('bold is applied', styled('a **b** c', 'bold', 'b'));
check('asterisk italics are applied', styled('*x*', 'italic', 'x'));
check('underscore italics are applied', styled('_x_', 'italic', 'x'));
check('underscore italics ignore words', plain('snake_case_name') === 'snake_case_name');
check('underline is applied', styled('__x__', 'underline', 'x'));
check('strikethrough is applied', styled('~~x~~', 'strike', 'x'));
check('spoilers are applied', styled('||x||', 'spoiler', 'x'));

const nested = inline('**a *b* c**');
check(
  'emphasis nests',
  nested.some((segment) => segment.value === 'a ' && segment.styles?.bold && !segment.styles?.italic) &&
    nested.some((segment) => segment.value === 'b' && segment.styles?.bold && segment.styles?.italic),
);

check('inline code is literal', inline('`**x**`').some((segment) => segment.type === 'code' && segment.value === '**x**'));
check('backslash escapes markdown', plain('\\*x\\*') === '*x*');

// --- Links ---
check('bare urls become links', inline('see https://example.com/a').some((segment) => segment.type === 'link' && segment.href === 'https://example.com/a'));
check('trailing punctuation is left in the text', plain('see https://example.com/a.') === 'see https://example.com/a.');
check(
  'a url keeps its own parentheses',
  inline('https://en.wikipedia.org/wiki/Foo_(bar)').some(
    (segment) => segment.type === 'link' && segment.href === 'https://en.wikipedia.org/wiki/Foo_(bar)',
  ),
);
check(
  'a wrapping parenthesis is dropped',
  inline('(https://example.com/a)').some((segment) => segment.type === 'link' && segment.href === 'https://example.com/a'),
);
check(
  'masked links keep their label',
  inline('[docs](https://example.com)').some(
    (segment) => segment.type === 'link' && segment.value === 'docs' && segment.noEmbed === true,
  ),
);
check(
  'angle links suppress embeds',
  inline('<https://example.com>').some((segment) => segment.type === 'link' && segment.noEmbed === true),
);
check(
  'a bare link may be embedded',
  inline('https://example.com').every((segment) => segment.type !== 'link' || segment.noEmbed !== true),
);
check('javascript urls are never linked', inline('javascript:alert(1)').every((segment) => segment.type !== 'link'));

// --- Emoji and mentions ---
const emoji = new Map([['YES', { id: 'e1', name: 'YES', hash: 'h', animated: false }]]);
check(
  'a known emoji resolves',
  inline('hi :YES: there', emoji).some((segment) => segment.type === 'emoji' && segment.emoji.id === 'e1'),
);
check('emoji names are case-sensitive', plain(':yes:', emoji) === ':yes:');
check('an unknown emoji stays literal', plain(':nope:', emoji) === ':nope:');

const alice = { id: 'u1', username: 'alice' };
const mentionOf = (name) => (name.toLowerCase() === 'alice' ? alice : undefined);
check('a mention resolves', inline('hey @alice', noEmoji, mentionOf).some((segment) => segment.type === 'mention'));
check('an unknown mention stays literal', plain('hey @bob', noEmoji, mentionOf) === 'hey @bob');
check(
  'reserved mentions stay literal',
  inline('@everyone', noEmoji, () => alice).every((segment) => segment.type !== 'mention'),
);
check('an email is not a mention', plain('me@example.com', noEmoji, mentionOf) === 'me@example.com');
check('a url is not mistaken for an emoji or mention', inline('https://x.com/:YES:').some((segment) => segment.type === 'link'));

// --- Catching up after being away ---
// A stand-in shape: mergeLatest only ever compares ids and copies references.
const message = (id, extra = {}) => ({ id, channelId: 'c1', content: id, ...extra });

check(
  'a catch-up page is appended in the order the server sent it',
  mergeLatest([message('1'), message('2')], [message('2'), message('3'), message('4')])
    .map((entry) => entry.id)
    .join(',') === '1,2,3,4',
);
check(
  'a message already loaded is refreshed rather than duplicated',
  mergeLatest([message('1', { content: 'old' })], [message('1', { content: 'edited' })])[0]?.content === 'edited',
);
check(
  'a refreshed message keeps its position',
  mergeLatest([message('1'), message('2'), message('3')], [message('2')])
    .map((entry) => entry.id)
    .join(',') === '1,2,3',
);
check(
  'a refresh never drops what was already loaded',
  mergeLatest([message('1'), message('2')], [message('2')]).length === 2,
);
check('catching up on an empty channel loads the page', mergeLatest([], [message('1')]).length === 1);
check('an empty catch-up page changes nothing', mergeLatest([message('1')], []).length === 1);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
