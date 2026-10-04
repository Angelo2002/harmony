// Focused checks for the client's pure logic: parsing message text into markdown,
// links, emoji and mentions, the merge that catches up after being away, deciding
// whether a message is aimed at you, and what the emoji picker offers and finds.
//
// Run with: npm run smoke:text
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { listEmbeddableUrls, matchChannelName, rewriteChannelMentions } from '@harmony/shared';
import { highlight } from '../src/lib/highlighter.ts';
import { inlineSegmentsOf, parseMessage } from '../src/lib/message-text.ts';
import { mergeLatest, mentionsUser } from '../src/lib/messages.ts';
import { formatTimestamp, formatTimestampTitle } from '../src/lib/timestamp.ts';
import { filterByName, filterUnicodeGroups } from '../src/lib/unicode-emoji.ts';

const require = createRequire(import.meta.url);

let failures = 0;
function check(name, condition) {
  const ok = Boolean(condition);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

const noEmoji = new Map();
const noMention = () => undefined;

/** Every inline segment of a message, skipping code blocks. */
function inline(text, emoji = noEmoji, mention = noMention, channels = []) {
  return inlineSegmentsOf(parseMessage(text, emoji, mention, channels));
}

/** The concatenated visible text, ignoring styling. */
function plain(text, emoji = noEmoji, mention = noMention, channels = []) {
  return inline(text, emoji, mention, channels)
    .map((segment) => segment.value)
    .join('');
}

function parse(text, emoji = noEmoji, mention = noMention, channels = []) {
  return parseMessage(text, emoji, mention, channels);
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
check('a quote drops the markers', plain('> one\n> two') === 'one\ntwo');

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

// --- Channel references ---
// A channel name may contain a space, so a reference is resolved against the
// names that exist rather than matched by shape; longest wins.
const channels = [
  { id: 'c1', name: 'general' },
  { id: 'c2', name: 'Off Topic' },
  { id: 'c3', name: 'Off' },
  { id: 'c4', name: 'dev' },
];
const channelIn = (text) => inline(text, noEmoji, noMention, channels).find((segment) => segment.type === 'channel');

check('a channel reference resolves', channelIn('see #general now')?.channel.id === 'c1');
check('a channel reference is case-insensitive', channelIn('#GENERAL')?.channel.name === 'general');
check('a spaced channel name resolves whole', channelIn('in #Off Topic please')?.channel.id === 'c2');
check('the longest channel name wins', channelIn('#Off Topic')?.channel.id === 'c2');
check('a short name still works on its own', channelIn('#Off')?.channel.id === 'c3');
check('a name running into a word is not a reference', channelIn('#generalissimo') === undefined);
check('an unknown channel stays literal', plain('see #nope', noEmoji, noMention, channels) === 'see #nope');
check('a mid-word hash is not a reference', channelIn('issue#42') === undefined);
// The `#` (like a mention's `@`) is added at render, so rebuild it to compare.
const rendered = (text) =>
  inline(text, noEmoji, noMention, channels)
    .map((segment) => (segment.type === 'channel' ? `#${segment.value}` : segment.value))
    .join('');
check('a channel reference keeps its text', rendered('see #general now') === 'see #general now');
check(
  'a channel reference inside code is literal',
  inline('`#general`', noEmoji, noMention, channels).every((segment) => segment.type !== 'channel'),
);

check('matchChannelName is case-insensitive', matchChannelName('GENERAL rest', ['general']) === 'general');
check('matchChannelName needs a boundary', matchChannelName('generalx', ['general']) === null);
check('matchChannelName prefers the longest', matchChannelName('Off Topic', ['Off', 'Off Topic']) === 'Off Topic');
check('rewriting maps a known name', rewriteChannelMentions('go #general now', ['general'], () => '<#123>') === 'go <#123> now');
check('rewriting leaves an unknown name', rewriteChannelMentions('go #nope now', ['general'], () => '<#123>') === 'go #nope now');
check('rewriting leaves a mid-word hash', rewriteChannelMentions('a#general', ['general'], () => 'X') === 'a#general');

// --- Lists ---
const bullets = parse('- one\n- two');
check('dash lines make a bulleted list', bullets.length === 1 && bullets[0].type === 'list' && !bullets[0].ordered);
check('each line is an item', bullets[0].items.length === 2);
check('star bullets work too', parse('* one\n* two')[0]?.type === 'list');

const tree = parse('- a\n  - b\n    - c\n- d')[0];
check('the top of a nested list keeps its own items', tree.items.map((item) => item.segments[0].value).join() === 'a,d');
check('two spaces nest an item under the one above', tree.items[0].children[0]?.items[0]?.segments[0]?.value === 'b');
check('nesting goes deeper with more indent', tree.items[0].children[0].items[0].children[0]?.items[0]?.segments[0]?.value === 'c');
check('one space is not enough to nest', parse('- a\n - b')[0].items.length === 2);

const numbered = parse('3. three\n4. four');
check('a numbered list is ordered', numbered[0].type === 'list' && numbered[0].ordered);
check('a numbered list starts at its first number', numbered[0].start === 3 && numbered[0].items.length === 2);
const mixed = parse('1. a\n   - b')[0];
check('a bulleted list can nest under a numbered one', mixed.ordered && mixed.items[0].children[0]?.ordered === false);
check('switching between bullets and numbers starts a new list', parse('- a\n1. b').length === 2);
check('a line without a marker ends the list', parse('- a\nafter').map((block) => block.type).join() === 'list,paragraph');
check('an indented line carries on the item', plain('- a\n  more') === 'a\nmore' && parse('- a\n  more').length === 1);

const richItem = inline('- **bold** for @alice', noEmoji, (name) => (name === 'alice' ? { id: 'u1', username: 'alice' } : undefined));
check('an item keeps its inline formatting', richItem.some((segment) => segment.styles?.bold && segment.value === 'bold'));
check('an item can mention someone', richItem.some((segment) => segment.type === 'mention'));
check(
  'a mention inside a nested item still counts as one',
  mentionsUser({ id: 'm', content: '- x\n  - hey @alice' }, 'u1', (name) => (name === 'alice' ? { id: 'u1' } : undefined)),
);
check(
  'a link in an item is a link',
  inline('- see https://example.com/a').some((segment) => segment.type === 'link' && segment.href === 'https://example.com/a'),
);
check('a link in an item can still unfurl', listEmbeddableUrls('- see https://example.com/a').includes('https://example.com/a'));

// What looks a little like a list but is not one.
check('a minus sign is not a bullet', parse('-5 degrees')[0].type === 'paragraph' && plain('-5 degrees') === '-5 degrees');
check('a decimal is not a numbered item', parse('1.5 liters')[0].type === 'paragraph');
check('a lone dash is just a dash', parse('-')[0].type === 'paragraph');
check('stars hugging a word are italics, not a bullet', styled('*shrug*', 'italic', 'shrug'));
check('stars with spaces inside are arithmetic', plain('2 * 3 * 4') === '2 * 3 * 4' && !inline('2 * 3 * 4').some((segment) => segment.styles?.italic));

// --- Quotes, headers and subtext ---
const rest = parse('before\n>>> a\nb\n\nc');
check('>>> quotes the rest of the message', rest.length === 2 && rest[1].type === 'quote');
check('>>> keeps every line after it', inlineSegmentsOf(rest[1].blocks).map((segment) => segment.value).join('') === 'a\nb\n\nc');
check('a quote line needs its space', parse('>.<')[0].type === 'paragraph' && parse('>>>')[0].type === 'paragraph');
check('a single quote ends with its last marked line', parse('> a\nb').map((block) => block.type).join() === 'quote,paragraph');
check('a quote can hold a list', parse('> - a\n> - b')[0].blocks[0]?.type === 'list');
check('quotes do not nest', parse('> > a')[0].blocks[0]?.type === 'paragraph');

check('subtext is its own block', parse('-# small print')[0].type === 'subtext' && plain('-# small print') === 'small print');
check('subtext needs its space', parse('-#tag')[0].type === 'paragraph');
check('a level 3 header is detected', parse('### Title')[0].type === 'header' && parse('### Title')[0].level === 3);
check('four hashes are not a header', parse('#### Title')[0].type === 'paragraph');
check('a header needs its space', parse('#Title')[0].type === 'paragraph');
check('a header needs a title', parse('# ')[0].type === 'paragraph');

// --- Escaping ---
check('escaped stars are literal', plain('\\*not italic\\*') === '*not italic*' && !inline('\\*not italic\\*').some((segment) => segment.styles?.italic));
check('an escaped dash is not a bullet', parse('\\- not a list')[0].type === 'paragraph' && plain('\\- not a list') === '- not a list');
check('an escaped hash is not a header', parse('\\# not a header')[0].type === 'paragraph');
check('an escaped number is not an item', plain('1\\. not a list') === '1. not a list' && parse('1\\. not a list')[0].type === 'paragraph');
check('an escaped mention stays text', inline('\\@alice', noEmoji, mentionOf).every((segment) => segment.type !== 'mention'));
check('an escaped emoji stays text', plain('\\:YES:', emoji) === ':YES:');
check('a backslash can escape itself', plain('\\\\') === '\\');
check('a backslash before a letter is kept', plain('C:\\Users') === 'C:\\Users');

// --- Timestamps ---
const stamp = (text) => inline(text).find((segment) => segment.type === 'timestamp');
check('a timestamp is recognised', stamp('at <t:1700000000>')?.epochMs === 1_700_000_000_000);
check('a timestamp without a style uses f', stamp('<t:1700000000>')?.style === 'f');
check('a timestamp keeps its style', stamp('<t:1700000000:R>')?.style === 'R');
check('an unknown style stays as written', stamp('<t:1700000000:X>') === undefined && plain('<t:1700000000:X>') === '<t:1700000000:X>');
check('an escaped timestamp stays as written', stamp('\\<t:1700000000>') === undefined);
check('a moment past what a date holds stays as written', stamp('<t:9999999999999>') === undefined);

const utc = { locale: 'en-US', timeZone: 'UTC' };
check('t is a short time', /^12:00\sAM$/.test(formatTimestamp(0, 't', utc)));
check('T is a long time', /^12:00:00\sAM$/.test(formatTimestamp(0, 'T', utc)));
check('d is a short date', formatTimestamp(0, 'd', utc) === '01/01/1970');
check('D is a long date', formatTimestamp(0, 'D', utc) === 'January 1, 1970');
check('f is a date and time', /^January 1, 1970( at|,) 12:00\sAM$/.test(formatTimestamp(0, 'f', utc)));
check('F adds the weekday', formatTimestamp(0, 'F', utc).startsWith('Thursday, January 1, 1970'));
check('the tooltip is the full date', formatTimestampTitle(0, utc) === formatTimestamp(0, 'F', utc));
const hour = 60 * 60 * 1000;
check('R reads ahead', formatTimestamp(10 * hour, 'R', { now: 7 * hour, locale: 'en-US' }) === 'in 3 hours');
check('R reads behind', formatTimestamp(0, 'R', { now: 50 * hour, locale: 'en-US' }) === '2 days ago');

// --- Code blocks ---
check('a code block keeps its language', parse('```python\nprint(1)\n```')[0].language === 'python');
check('a code block may close at the end of its last line', parse('```js\nfoo()```\nafter').map((block) => block.type).join() === 'code,paragraph');
check('a closing fence on the last line keeps that line', parse('```js\nfoo()```')[0].text === 'foo()');
check('a code block may sit on one line', parse('```x = 1```')[0].type === 'code' && parse('```x = 1```')[0].text === 'x = 1');
check('markdown inside code is literal', parse('```\n- a\n# b\n```').length === 1);

// The highlighter's output goes into the page as markup, so it must escape the
// code it is given; this is what makes that safe.
const hostile = highlight('<img src=x onerror="alert(1)"> & </code><script>', 'html');
check('highlighted code is escaped', hostile !== null && !hostile.includes('<img') && !hostile.includes('<script') && hostile.includes('&lt;'));
check('highlighting adds only its own spans', hostile.replace(/<span class="hljs-[a-z_ .-]+">|<\/span>/g, '').search(/[<>]/) === -1);
check('a language alias resolves', highlight('const a = 1;', 'js')?.includes('hljs-keyword'));
check('a language name ignores case', highlight('x = 1', 'Python') !== null);
check('an unknown language is left plain', highlight('x', 'brainfudge') === null);

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

// --- Whether a message is aimed at you ---
// This decides the louder notification sound, so it is worth being exact about.
check('naming you counts', mentionsUser(message('1', { content: 'hey @alice' }), 'u1', mentionOf));
check('naming somebody else does not', !mentionsUser(message('1', { content: 'hey @bob' }), 'u1', mentionOf));
check(
  'a reply to you counts even without your name',
  mentionsUser(message('1', { content: 'sure', replyTo: { author: alice } }), 'u1', mentionOf),
);
check(
  'a reply to somebody else does not',
  !mentionsUser(message('1', { content: 'sure', replyTo: { author: { id: 'u2' } } }), 'u1', mentionOf),
);
check(
  'your name in a code block is a quotation, not a mention',
  !mentionsUser(message('1', { content: '```\n@alice\n```' }), 'u1', mentionOf),
);
check('a reserved mention is never yours', !mentionsUser(message('1', { content: '@everyone' }), 'u1', mentionOf));
check('an ordinary message is not a mention', !mentionsUser(message('1', { content: 'good morning' }), 'u1', mentionOf));

// --- Searching the emoji picker ---
const named = [{ name: 'YES' }, { name: 'No' }, { name: 'yes_animated' }];

check('an empty search keeps everything', filterByName(named, '').length === 3);
check('a search ignores case', filterByName(named, 'yes').length === 2);
check('a search matches anywhere in the name', filterByName(named, 'anim').length === 1);
check('a search trims the space around it', filterByName(named, '  no  ').length === 1);
check('a search matching nothing returns nothing', filterByName(named, 'zzz').length === 0);

const searchable = [
  { name: 'Smileys & Emotion', emojis: [{ name: 'grinning face' }, { name: 'joy' }] },
  { name: 'Animals & Nature', emojis: [{ name: 'dog face' }] },
];
check('a search narrows the emoji inside each group', filterUnicodeGroups(searchable, 'face').length === 2);
check('a search drops the groups left with no match', filterUnicodeGroups(searchable, 'dog').length === 1);
check('a search matching nothing leaves no groups', filterUnicodeGroups(searchable, 'zzz').length === 0);
check('an empty search keeps every group intact', filterUnicodeGroups(searchable, '').length === 2);

// --- The unicode emoji data ---
// Read straight from the package, since the client reaches it through a
// bundler-only dynamic import that plain Node cannot perform. This guards the
// shape the picker relies on, which a package upgrade could otherwise change
// into an empty list with no error anywhere.
const emojiData = JSON.parse(
  readFileSync(require.resolve('unicode-emoji-json/data-by-group.json'), 'utf8'),
);

check('the unicode emoji data arrives as groups', Array.isArray(emojiData) && emojiData.length > 0);
check(
  'every group names itself and holds emoji that have names',
  emojiData.every(
    (group) =>
      typeof group.name === 'string' &&
      group.name.length > 0 &&
      Array.isArray(group.emojis) &&
      group.emojis.length > 0 &&
      group.emojis.every((emoji) => typeof emoji.emoji === 'string' && typeof emoji.name === 'string'),
  ),
);

const emojiCount = emojiData.reduce((total, group) => total + group.emojis.length, 0);
check('the set is the whole range rather than a sample', emojiCount > 1000, `${emojiCount} emoji`);
check(
  'a known emoji can be found by name',
  filterByName(
    emojiData.flatMap((group) => group.emojis),
    'waving hand',
  ).some((emoji) => emoji.emoji === '👋'),
);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
