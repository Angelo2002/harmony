// Focused checks for the client's pure logic: parsing message text into markdown,
// links, emoji and mentions, the merge that catches up after being away, deciding
// whether a message is aimed at you, what the emoji picker offers and finds, and
// the quick switcher's matching, the channel arrows and the unread tab title.
//
// Run with: npm run smoke:text
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { matchChannelName, rewriteChannelMentions } from '@harmony/shared';
import { parseMessage } from '../src/lib/message-text.ts';
import { mergeLatest, mentionsUser } from '../src/lib/messages.ts';
import {
  matchScore,
  rankSwitcher,
  sidebarOrder,
  stepChannel,
  unreadBadge,
  unreadTitle,
} from '../src/lib/quick-switch.ts';
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
  return parseMessage(text, emoji, mention, channels).flatMap((block) =>
    block.type === 'code' ? [] : block.segments,
  );
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

// --- Quick switcher matching ---
check('an exact name beats a prefix', matchScore('general', 'general') > matchScore('general', 'general-chat'));
check('a prefix beats a word inside the name', matchScore('gen', 'general') > matchScore('gen', 'off-topic-gen'));
check(
  'a word inside the name beats a bare substring',
  matchScore('chat', 'general-chat') > matchScore('hat', 'general-chat'),
);
check('initials find a hyphenated name', matchScore('gc', 'general-chat') !== null);
check('letters in order still match', matchScore('gnrl', 'general') !== null);
check('letters out of order do not', matchScore('lrng', 'general') === null);
check('matching ignores case', matchScore('GEN', 'general') === matchScore('gen', 'general'));
check('a space can stand in for a hyphen', matchScore('general chat', 'general-chat') !== null);
check('separators alone match nothing', matchScore('--', 'general') === null);
check('a shorter name wins a tie', matchScore('dev', 'devops') > matchScore('dev', 'developers'));

// --- Sidebar order and the channel arrows ---
const switchCategories = [
  { id: 'cat-b', name: 'Games' },
  { id: 'cat-a', name: 'Text' },
];
const switchChannels = [
  { id: 'loose', name: 'lobby', categoryId: null },
  { id: 'gen', name: 'general', categoryId: 'cat-a' },
  { id: 'mc', name: 'minecraft', categoryId: 'cat-b' },
  { id: 'off', name: 'off-topic', categoryId: 'cat-a' },
  { id: 'orphan', name: 'ghost', categoryId: 'cat-gone' },
];
const switchOrder = sidebarOrder(switchCategories, switchChannels).map((channel) => channel.id);
check('sidebar order follows categories, then uncategorised channels', switchOrder.join(',') === 'mc,gen,off,loose');
check('a channel in an unknown category is left out, as the sidebar does', !switchOrder.includes('orphan'));
check('down moves to the next channel', stepChannel(switchOrder, 'gen', 1) === 'off');
check('up moves to the previous channel', stepChannel(switchOrder, 'gen', -1) === 'mc');
check('down from the last channel wraps to the first', stepChannel(switchOrder, 'loose', 1) === 'mc');
check('up from the first channel wraps to the last', stepChannel(switchOrder, 'mc', -1) === 'loose');
check('with nothing open, down starts at the top', stepChannel(switchOrder, null, 1) === 'mc');
check('with nothing open, up starts at the bottom', stepChannel(switchOrder, null, -1) === 'loose');
check('a lone channel has nowhere to go', stepChannel(['only'], 'only', 1) === null);
check('no channels means no step', stepChannel([], null, 1) === null);
const unreadOnly = (id) => id === 'loose' || id === 'gen';
check('the unread arrow skips read channels', stepChannel(switchOrder, 'mc', 1, unreadOnly) === 'gen');
check('the unread arrow goes up too', stepChannel(switchOrder, 'off', -1, unreadOnly) === 'gen');
check('the unread arrow wraps past the end', stepChannel(switchOrder, 'loose', 1, unreadOnly) === 'gen');
check(
  'the unread arrow never lands on the open channel',
  stepChannel(switchOrder, 'gen', 1, (id) => id === 'gen') === null,
);

// --- Quick switcher ranking ---
const switchMembers = [
  { id: 'u1', username: 'genevieve', displayName: null },
  { id: 'u2', username: 'bob', displayName: 'Minecraft Bob' },
];
const rank = (query, extra = {}) =>
  rankSwitcher({
    query,
    categories: switchCategories,
    channels: switchChannels,
    members: switchMembers,
    recentChannelIds: [],
    activeChannelId: null,
    ...extra,
  });
const rowIds = (rows) => rows.map((row) => `${row.kind}:${row.id}`).join(',');

check(
  'an empty query lists channels alone, in sidebar order',
  rowIds(rank('')) === 'channel:mc,channel:gen,channel:off,channel:loose',
);
check(
  'an empty query puts recent channels first and the open one last',
  rowIds(rank('', { recentChannelIds: ['gen', 'loose', 'off'], activeChannelId: 'gen' })) ===
    'channel:loose,channel:off,channel:mc,channel:gen',
);
check('a query finds channels and members alike', rowIds(rank('gen')) === 'channel:gen,member:u1');
check('a channel carries its category name', rank('minec')[0].category === 'Games');
check('an uncategorised channel has no category', rank('lobby')[0].category === null);
check('a member is found by username', rowIds(rank('bob')) === 'member:u2');
check('a member is found by display name', rowIds(rank('minecraft b')) === 'member:u2');
check('a channel ranks ahead of a member matching as well', rowIds(rank('minecraft')) === 'channel:mc,member:u2');
check('a leading # keeps to channels', rowIds(rank('#minecraft')) === 'channel:mc');
check('a leading @ keeps to members', rowIds(rank('@minecraft')) === 'member:u2');
check('a bare @ lists nobody rather than everyone', rank('@').length === 0);
check('a bare # lists channels as an empty query does', rowIds(rank('#')) === rowIds(rank('')));
const twins = [
  { id: 'red', name: 'team-red', categoryId: null },
  { id: 'blu', name: 'team-blu', categoryId: null },
];
check(
  'a tie between equal matches keeps sidebar order',
  rowIds(rank('team', { channels: twins })) === 'channel:red,channel:blu',
);
check(
  'recency breaks a tie between equal matches',
  rowIds(rank('team', { channels: twins, recentChannelIds: ['blu'] })) === 'channel:blu,channel:red',
);
check('the result list is capped', rank('', { limit: 2 }).length === 2);
check('a query matching nothing lists nothing', rank('zzz').length === 0);

// --- Unread tab title and app badge ---
check('nothing unread shows the bare name', unreadTitle('Harmony', 0, 0) === 'Harmony');
check('unread without mentions shows a dot', unreadTitle('Harmony', 0, 3) === '• Harmony');
check('mentions show how many channels hold one', unreadTitle('Harmony', 2, 5) === '(2) Harmony');
check('the app badge is a number for mentions', unreadBadge(2, 5) === 2);
check('the app badge is a dot for plain unread', unreadBadge(0, 1) === 'dot');
check('the app badge clears when all is read', unreadBadge(0, 0) === null);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
