import { DomHandler, DomUtils, Parser, parseDocument } from 'htmlparser2';
import { compile } from 'css-select';
import postcss from 'postcss';
import { CollectorError } from './collector-security.js';

const MAX_HTML_LENGTH = 4 * 1024 * 1024;
const MAX_PARSE_EVENTS = 100_000;
const MAX_DEPTH = 128;
const MAX_CSS_LENGTH = 256 * 1024;
const MAX_CSS_NODES = 10_000;
const MAX_SELECTOR_LENGTH = 1024;
const MAX_SELECTOR_TESTS = 500_000;
const OMIT_TEXT = new Set(['script', 'style', 'nav', 'noscript', 'form', 'template']);
const CHALLENGE = /当前环境异常|完成验证后即可继续访问|访问过于频繁|请完成安全验证|verify you are human|checking your browser/i;
const REMOVED = /该内容已被发布者删除|此内容因违规无法查看|你暂无权限查看此页面内容|此内容已被删除/;
const CSS_IMAGE_PROPERTIES = /^(?:background(?:-image)?|(?:-webkit-)?mask(?:-image)?|border-image(?:-source)?|list-style(?:-image)?|content)$/;

function tooLarge() {
  throw new CollectorError('RESOURCE_TOO_LARGE', '文章结构或样式超过安全解析范围，采集未完成');
}

function boundedDocument(html) {
  const handler = new DomHandler();
  let events = 0;
  let depth = 0;
  const count = () => { if (++events > MAX_PARSE_EVENTS) tooLarge(); };
  const callbacks = {
    onparserinit: parser => handler.onparserinit(parser),
    onopentag(name, attributes) {
      count();
      if (++depth > MAX_DEPTH) tooLarge();
      handler.onopentag(name, attributes);
    },
    onclosetag() { handler.onclosetag(); depth--; },
    ontext(value) { count(); handler.ontext(value); },
    oncomment(value) { count(); handler.oncomment(value); },
    oncommentend: () => handler.oncommentend(),
    onprocessinginstruction(name, value) { count(); handler.onprocessinginstruction(name, value); },
    onend: () => handler.onend(),
  };
  new Parser(callbacks, { decodeEntities: true }).end(html);
  return handler.root;
}

// Iterative traversal also avoids recursion in source-controlled DOM depth.
function elementsWithin(node, includeRoot = true) {
  const elements = [];
  const stack = includeRoot ? [node] : [...(node.children || [])].reverse();
  while (stack.length) {
    const current = stack.pop();
    if (current.attribs) elements.push(current);
    // A browser's querySelector does not traverse template.content.
    if (current.name === 'template') continue;
    for (let index = (current.children?.length || 0) - 1; index >= 0; index--) stack.push(current.children[index]);
  }
  return elements;
}

function ensureBody(document) {
  const elements = elementsWithin(document);
  if (elements.some(element => element.name === 'body')) return;
  // htmlparser2 preserves fragments instead of inserting HTML/body elements.
  // Keep head metadata outside the body, as the inert browser previously did.
  const holder = elements.find(element => element.name === 'html') || document;
  const headNames = new Set(['head', 'title', 'meta', 'base', 'link']);
  const body = parseDocument('<body></body>').children[0];
  body.parent = holder;
  body.children = holder.children.filter(node => node.type !== 'directive' && !headNames.has(node.name));
  holder.children = [...holder.children.filter(node => node.type === 'directive' || headNames.has(node.name)), body];
  for (const parent of [holder, body]) {
    parent.children.forEach((child, index, siblings) => {
      child.parent = parent;
      child.prev = siblings[index - 1] || null;
      child.next = siblings[index + 1] || null;
    });
  }
}

function textOf(node, omit = OMIT_TEXT) {
  const chunks = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (omit.has(current.name)) continue;
    if (current.type === 'text') chunks.push(current.data);
    for (let index = (current.children?.length || 0) - 1; index >= 0; index--) stack.push(current.children[index]);
  }
  return chunks.join('');
}

function cssDecoded(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\\([^\r\n\f])/gi,
    (_match, hex, character) => hex ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16) || 0xfffd, 0x10ffff)) : character);
}

function withoutStrings(value) {
  let result = '';
  let quote = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      result += ' ';
      if (character === '\\') { result += ' '; index++; }
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") { quote = character; result += ' '; }
    else result += character;
  }
  return result;
}

function hasImageValue(value, variables, seen = new Set(), resolved = new Map()) {
  const decoded = cssDecoded(value);
  const syntax = withoutStrings(decoded);
  if (/\b(?:url|image|(?:-webkit-)?image-set|cross-fade|element|paint|attr)\s*\(|\b(?:inherit|revert(?:-layer)?)\b/i.test(syntax)) return true;
  const calls = /\bvar\s*\(/gi;
  for (let match; (match = calls.exec(syntax));) {
    let end = calls.lastIndex;
    let depth = 1;
    for (; end < syntax.length && depth; end++) {
      if (syntax[end] === '(') depth++;
      if (syntax[end] === ')') depth--;
    }
    if (depth || seen.size >= 16) return true;
    const argument = decoded.slice(calls.lastIndex, end - 1);
    const comma = argument.indexOf(',');
    const name = (comma < 0 ? argument : argument.slice(0, comma)).trim();
    if (!/^--[\w-]+$/.test(name) || seen.has(name)) return true;
    const values = variables.get(name);
    const nextSeen = new Set([...seen, name]);
    if (values?.length) {
      if (!resolved.has(name)) resolved.set(name, values.some(candidate => hasImageValue(candidate, variables, nextSeen, resolved)));
      if (resolved.get(name)) return true;
    } else if (comma < 0 || hasImageValue(argument.slice(comma + 1), variables, nextSeen, resolved)) return true;
    calls.lastIndex = end;
  }
  return false;
}

function selectorWithoutPseudoElements(selector) {
  let result = '';
  let quote = '';
  let brackets = 0;
  for (let index = 0; index < selector.length; index++) {
    const character = selector[index];
    if (character === '\\') { result += selector.slice(index, index + 2); index++; continue; }
    if (quote) { result += character; if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; result += character; continue; }
    if (character === '[') brackets++;
    if (character === ']') brackets--;
    if (!brackets && character === ':') {
      const pseudo = /^::?(?:before|after|first-line|first-letter|marker)\b|^:(?:hover|focus(?:-within|-visible)?|active|visited|target)\b/i.exec(selector.slice(index));
      if (pseudo) { index += pseudo[0].length - 1; continue; }
    }
    result += character;
  }
  // A bare pseudo-element applies to every element. Do not split selector lists
  // on commas here: attribute strings and functional pseudos may contain commas.
  return result.trim() || '*';
}

function unsupportedCss(allElements, articleElements) {
  const sheets = [];
  let length = 0;
  let nodes = 0;
  const variables = new Map();
  const candidates = [];
  const add = (text, element) => {
    length += text.length;
    if (length > MAX_CSS_LENGTH) tooLarge();
    let ast;
    try { ast = postcss.parse(element ? `archive-inline{${text}}` : text, { from: undefined }); }
    catch { return false; }
    const stack = [{ node: ast, depth: 0 }];
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (++nodes > MAX_CSS_NODES || depth > 32) tooLarge();
      if (node.type === 'atrule' && cssDecoded(node.name).toLowerCase() === 'import') return false;
      if (node.type === 'decl') {
        const property = cssDecoded(node.prop).toLowerCase();
        if (property.startsWith('--')) {
          const values = variables.get(property) || [];
          values.push(node.value);
          variables.set(property, values);
        } else if (CSS_IMAGE_PROPERTIES.test(property)) {
          candidates.push({ node, element });
        }
      }
      for (const child of node.nodes || []) stack.push({ node: child, depth: depth + 1 });
    }
    return true;
  };
  const articleSet = new Set(articleElements);
  for (const element of allElements) {
    if (element.name === 'style') sheets.push({ text: textOf(element, new Set()), element: null });
    if (element.attribs.style) sheets.push({ text: element.attribs.style, element });
  }
  // Parse all custom-property definitions before checking their use. Ancestor
  // definitions and stylesheet order cannot hide a possible image in a variable.
  for (const sheet of sheets) if (!add(sheet.text, sheet.element)) return true;
  let tests = 0;
  const resolved = new Map();
  for (const { node, element } of candidates) {
    if (!hasImageValue(node.value, variables, new Set(), resolved)) continue;
    if (element) { if (articleSet.has(element)) return true; continue; }
    let rule = node.parent;
    while (rule && rule.type !== 'rule') rule = rule.parent;
    if (!rule?.selector || rule.selector.length > MAX_SELECTOR_LENGTH || /:(?:has|i?contains)\s*\(/i.test(rule.selector)) return true;
    // Keyframe selectors name animation positions, not DOM elements. A static
    // selector test cannot establish that their images never affect the article.
    for (let ancestor = rule.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.type === 'atrule' && /(?:^|-)keyframes$/i.test(cssDecoded(ancestor.name))) return true;
    }
    let matches;
    try {
      // Matching dynamic state as potentially active is deliberately conservative.
      matches = compile(selectorWithoutPseudoElements(rule.selector), { xmlMode: false });
    } catch { return true; }
    for (const target of articleElements) {
      if (++tests > MAX_SELECTOR_TESTS) tooLarge();
      if (matches(target)) return true;
    }
  }
  return false;
}

function createdSeconds(scripts) {
  for (const script of scripts) {
    // Only literal var ct assignments outside comments and strings are metadata.
    // The source JavaScript is never evaluated.
    for (let index = 0; index < script.length;) {
      const character = script[index];
      if (character === '/' && script[index + 1] === '/') {
        const end = script.indexOf('\n', index + 2); index = end < 0 ? script.length : end + 1;
      } else if (character === '/' && script[index + 1] === '*') {
        const end = script.indexOf('*/', index + 2); index = end < 0 ? script.length : end + 2;
      } else if (character === '"' || character === "'" || character === '`' || character === '/') {
        const quote = character;
        for (index++; index < script.length; index++) {
          if (script[index] === '\\') index++;
          else if (script[index] === quote) { index++; break; }
        }
      } else {
        if (script.startsWith('var', index) && !/[\w$]/.test(script[index - 1] || '')) {
          const match = /^var\s+ct\s*=\s*(?:"(\d{10})"|'(\d{10})'|(\d{10}))\s*;/.exec(script.slice(index));
          if (match) return Number(match[1] || match[2] || match[3]);
        }
        index++;
      }
    }
  }
  return null;
}

/** Parse bounded, inert source HTML. Fetching, public-URL and image validation stay with the caller. */
export function parseArticleHtml(html, { url, wechat } = {}) {
  if (typeof html !== 'string') throw new CollectorError('ARTICLE_INVALID', '文章 HTML 格式不正确');
  if (html.length > MAX_HTML_LENGTH) tooLarge();
  try { new URL(url); } catch { throw new CollectorError('INVALID_URL', '文章地址格式不正确'); }
  const document = boundedDocument(html);
  ensureBody(document);
  const all = elementsWithin(document);
  const first = predicate => all.find(predicate);
  const byId = id => first(element => element.attribs.id === id);
  const byName = name => first(element => element.name === name);
  const body = byName('body') || document;
  const article = first(element => element.name === 'article');
  const root = wechat ? byId('js_content') : first(element => element.name === 'article' || element.name === 'main' || element.attribs.role === 'main') || body;
  const pageText = textOf(body);
  const challengeMarkers = CHALLENGE.test(pageText.slice(0, 6000));
  const removed = REMOVED.test(pageText);
  const empty = { invalid: true, challenge: challengeMarkers, removed, html: '', text: '', images: [], title: '', author: '', source_name: '', date: '', canonical: '', created_seconds: null, unsupported_background: false };
  if (!root) return empty;
  const within = elementsWithin(root);
  const images = [];
  for (const element of within) {
    if (element === root || element.name !== 'img') continue;
    const attributes = element.attribs;
    const candidate = [attributes['data-src'], attributes['data-original'], attributes.src].map(value => value?.trim()).find(Boolean) || '';
    let source = candidate;
    if (candidate) { try { source = new URL(candidate, url).href; } catch { /* caller rejects invalid image URLs */ } }
    images.push(source);
    attributes.src = source;
    delete attributes.srcset;
    delete attributes['data-src'];
    delete attributes['data-original'];
  }
  const meta = (...keys) => keys.map(([attribute, value]) => first(element => element.name === 'meta' && element.attribs[attribute] === value)?.attribs.content?.trim()).find(Boolean) || '';
  const text = (...nodes) => nodes.map(node => node && textOf(node).trim()).find(Boolean) || '';
  const textValue = textOf(root).replace(/\s+/g, ' ').trim();
  const hasContent = Boolean(textValue || images.length);
  let canonical = '';
  if (wechat) {
    const candidate = meta(['property', 'og:url']) || first(element => element.name === 'link' && element.attribs.rel?.toLowerCase() === 'canonical')?.attribs.href || '';
    try {
      const parsed = new URL(candidate, url);
      if (['https:', 'http:'].includes(parsed.protocol) && parsed.hostname === 'mp.weixin.qq.com' && parsed.searchParams.has('__biz') && parsed.searchParams.has('mid')) canonical = parsed.href;
    } catch { /* keep the original URL when no valid canonical exists */ }
  }
  return {
    invalid: !hasContent,
    challenge: wechat ? challengeMarkers && !hasContent : challengeMarkers && !article && pageText.length < 2000,
    removed, html: DomUtils.getInnerHTML(root, { encodeEntities: 'utf8', emptyAttrs: true }), text: textValue, images,
    title: text(byId('activity-name'), byName('h1')) || meta(['property', 'og:title']) || text(byName('title')),
    author: text(byId('js_author_name'), first(element => element.attribs.class?.split(/\s+/).includes('rich_media_meta_text'))) || meta(['name', 'author']),
    source_name: text(byId('js_name'), byId('profileBt')) || meta(['property', 'og:site_name']),
    date: meta(['property', 'article:published_time'], ['name', 'date']) || first(element => element.name === 'time' && element.attribs.datetime)?.attribs.datetime || '',
    canonical,
    created_seconds: wechat ? createdSeconds(all.filter(element => element.name === 'script' && !Object.hasOwn(element.attribs, 'src')).map(element => textOf(element, new Set()))) : null,
    unsupported_background: unsupportedCss(all, within),
  };
}
