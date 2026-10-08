// Browser-safe helpers shared by the renderer and the filesystem index.
export const markdownOptions = Object.freeze({ html: false, linkify: false, typographer: false });
export function inlineText(token) {
  if (!token?.children) return token?.content || '';
  return token.children.map(child => ['text', 'code_inline', 'image'].includes(child.type) ? child.content : ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '').join('').replace(/\s+/g, ' ').trim();
}
export function headingSlug(label) {
  return label.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-') || 'seccion';
}
export function assignHeadingAnchors(tokens) {
  const seen = new Map();
  const used = new Set();
  const headings = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;
    const label = inlineText(tokens[index + 1]);
    const slug = headingSlug(label);
    const count = seen.get(slug) || 0;
    seen.set(slug, count + 1);
    let anchor = count ? `${slug}-${count}` : slug;
    // A literal heading "Foo-1" cannot share an id with the second "Foo".
    while (used.has(anchor)) anchor += '-1';
    used.add(anchor);
    token.attrSet('id', anchor);
    headings.push({ anchor, label, level: Number(token.tag.slice(1)), line: (token.map?.[0] ?? 0) + 1, topLevel: token.level === 0 });
  }
  const stack = [];
  for (let index = headings.length - 1; index >= 0; index--) {
    while (stack.length && stack.at(-1).level > headings[index].level) stack.pop();
    headings[index].endLine = stack.at(-1)?.line ?? Infinity;
    stack.push(headings[index]);
  }
  let quoteDepth = 0;
  const items = [];
  for (const token of tokens) {
    if (token.type === 'blockquote_open') quoteDepth++;
    if (token.type === 'blockquote_close') quoteDepth--;
    if (token.type === 'list_item_open') items.push({ token, seen: false });
    if (token.type === 'list_item_close') items.pop();
    if (token.type !== 'inline' || !items.length || items.at(-1).seen) continue;
    items.at(-1).seen = true;
    if (!quoteDepth && /^\[([ xX])\](?:\s|$)/.test(token.content) && token.children?.[0]?.type === 'text') items.at(-1).token.attrSet('id', `task-line-${(token.map?.[0] ?? 0) + 1}`);
  }
  return headings;
}

function sourceLines(source) {
  const lines = source.split(/\r\n|\n|\r/);
  const offsets = [];
  let cursor = 0;
  for (const line of lines) { offsets.push(cursor); cursor += line.length + (source.slice(cursor + line.length, cursor + line.length + 2) === '\r\n' ? 2 : 1); }
  return { lines, offsets };
}
function inlineMap(content, map, raw, searchStart = 0, searchOffset = 0) {
  const result = [];
  let line = map?.[0] ?? searchStart;
  let column = Math.max(0, searchOffset - (raw.offsets[line] ?? 0));
  for (const piece of content.split('\n')) {
    let found = -1;
    const end = map?.[1] ?? raw.lines.length;
    for (; line < end; line++, column = 0) {
      found = raw.lines[line].indexOf(piece, column);
      if (found >= 0) break;
    }
    if (found < 0) return null;
    for (let index = 0; index < piece.length; index++) result.push(raw.offsets[line] + found + index);
    result.push(raw.offsets[line] + found + piece.length);
    line++;
  }
  return result;
}

export function createMarkdownParser(MarkdownIt) {
  const md = new MarkdownIt(markdownOptions);
  // Pinning MarkdownIt keeps these named rule wrappers stable; tests cover source offsets.
  for (const name of ['link', 'image', 'autolink']) {
    const rule = md.inline.ruler.__rules__.find(entry => entry.name === name).fn;
    md.inline.ruler.at(name, (state, silent) => {
      const start = state.pos;
      const count = state.tokens.length;
      const accepted = rule(state, silent);
      if (!accepted || silent || !state.env.knowledge) return accepted;
      const token = state.tokens.slice(count).find(item => item.type === 'link_open' || item.type === 'image');
      if (!token) return accepted;
      const tracker = state.env.knowledge;
      const mapping = tracker.mapping;
      const raw = state.src.slice(start, state.pos);
      const href = token.attrGet(token.type === 'image' ? 'src' : 'href');
      const originalStart = mapping?.[start];
      const line = originalStart == null ? tracker.line : tracker.raw.offsets.findLastIndex(offset => offset <= originalStart) + 1;
      const link = { href, line, label: token.type === 'image' ? token.content : raw, syntax: token.meta?.label ? 'reference' : name === 'autolink' ? 'autolink' : 'inline', destinationStart: null, destinationEnd: null, rawDestination: null };
      if (token.meta?.label) link.reference = token.meta.label;
      else {
        let destination = -1, end = -1;
        if (name === 'autolink') { destination = start + 1; end = state.pos - 1; }
        else {
          const saved = state.pos;
          const bracket = md.helpers.parseLinkLabel(state, start + (name === 'image' ? 1 : 0), true);
          state.pos = saved;
          if (bracket >= 0 && state.src[bracket + 1] === '(') {
            destination = bracket + 2;
            while (/\s/.test(state.src[destination] || '') && destination < state.pos) destination++;
            const parsed = md.helpers.parseLinkDestination(state.src, destination, state.pos);
            if (parsed.ok) { end = parsed.pos; if (state.src[destination] === '<') { destination++; end--; } }
          }
        }
        if (destination >= 0 && end >= destination && mapping?.[destination] != null && mapping?.[Math.max(destination, end - 1)] != null) {
          const a = mapping[destination], b = end === destination ? a : mapping[end - 1] + 1;
          if (tracker.source.slice(a, b) === state.src.slice(destination, end)) { link.destinationStart = a; link.destinationEnd = b; link.rawDestination = tracker.source.slice(a, b); }
        }
      }
      tracker.uses.push(link);
      return accepted;
    });
  }
  md.core.ruler.before('strip_references', 'knowledge_references', state => {
    const tracker = state.env.knowledge;
    if (!tracker) return;
    for (const token of state.tokens.filter(token => token.type === 'reference_definition')) {
      const label = token.meta.label;
      if (tracker.definitions.has(label)) continue;
      const startLine = token.map[0];
      const source = tracker.source.slice(tracker.raw.offsets[startLine], tracker.raw.offsets[token.map[1]] ?? tracker.source.length);
      const start = source.indexOf('[');
      const match = /^\[((?:\\.|[^\]])+)\]:\s*/.exec(source.slice(start));
      const entry = { href: state.env.references[label].href, line: startLine + 1, label, reference: label, syntax: 'reference', destinationStart: null, destinationEnd: null, rawDestination: null, uses: [] };
      if (match) {
        let pos = start + match[0].length;
        const parsed = md.helpers.parseLinkDestination(source, pos, source.length);
        if (parsed.ok && md.normalizeLink(parsed.str) === entry.href) {
          let end = parsed.pos;
          if (source[pos] === '<') { pos++; end--; }
          entry.destinationStart = tracker.raw.offsets[startLine] + pos;
          entry.destinationEnd = tracker.raw.offsets[startLine] + end;
          entry.rawDestination = tracker.source.slice(entry.destinationStart, entry.destinationEnd);
        }
      }
      tracker.definitions.set(label, entry);
    }
  });
  md.core.ruler.at('inline', state => {
    const tracker = state.env.knowledge;
    let enclosingMap = null;
    let searchStart = 0;
    let searchOffset = 0;
    for (const token of state.tokens) {
      if (token.map) enclosingMap = token.map;
      if (token.type !== 'inline') continue;
      tracker.mapping = inlineMap(token.content, token.map || enclosingMap, tracker.raw, searchStart, searchOffset);
      tracker.line = (token.map?.[0] ?? enclosingMap?.[0] ?? searchStart) + 1;
      token.meta = { ...token.meta, knowledgeLine: tracker.line };
      if (tracker.mapping?.length) { searchStart = tracker.raw.offsets.findLastIndex(offset => offset <= tracker.mapping[0]); searchOffset = tracker.mapping.at(-1); }
      md.inline.parse(token.content, state.md, state.env, token.children);
    }
  });
  return source => {
    if (typeof source !== 'string') throw new TypeError('La fuente Markdown debe ser texto.');
    const knowledge = { source, raw: sourceLines(source), uses: [], definitions: new Map(), mapping: null };
    const tokens = md.parse(source.startsWith('\uFEFF') ? source.slice(1) : source, { knowledge });
    const headings = assignHeadingAnchors(tokens).map(heading => ({ ...heading, endLine: Number.isFinite(heading.endLine) ? heading.endLine : knowledge.raw.lines.length + 1 }));
    const links = [...knowledge.definitions.values()];
    for (const use of knowledge.uses) {
      if (use.reference && knowledge.definitions.has(use.reference)) knowledge.definitions.get(use.reference).uses.push({ line: use.line, label: use.label });
      else links.push(use);
    }
    const tasks = [];
    const items = [];
    let quoteDepth = 0;
    const textLines = [];
    for (const token of tokens) {
      if (token.type === 'blockquote_open') quoteDepth++;
      if (token.type === 'blockquote_close') quoteDepth--;
      if (token.type === 'list_item_open') items.push({ token, seen: false });
      if (token.type === 'list_item_close') items.pop();
      if (token.type !== 'inline') continue;
      const label = inlineText(token);
      textLines.push({ line: token.meta?.knowledgeLine ?? (token.map?.[0] ?? 0) + 1, text: label });
      if (!items.length || items.at(-1).seen) continue;
      items.at(-1).seen = true;
      const match = /^\[([ xX])\](?:\s|$)/.exec(token.content);
      if (quoteDepth || !match || token.children?.[0]?.type !== 'text') continue;
      const line = (token.map?.[0] ?? 0) + 1;
      const taskLabel = label.replace(/^\[[ xX]\]\s*/, '');
      const number = /^(\d+(?:\.\d+)*)(?:[.)]?\s)/.exec(taskLabel)?.[1];
      tasks.push({ line, endLine: (items.at(-1).token.map?.[1] ?? line) + 1, anchor: `task-line-${line}`, label: taskLabel, done: match[1].toLowerCase() === 'x', ...(number ? { number } : {}) });
    }
    links.sort((a, b) => (a.destinationStart ?? Infinity) - (b.destinationStart ?? Infinity) || a.line - b.line);
    return { headings, anchors: [...headings.map(heading => heading.anchor), ...tasks.map(task => task.anchor)], links, tasks, text: textLines.map(line => line.text).join('\n'), textLines };
  };
}
