import MarkdownIt from 'markdown-it';
import { assignHeadingAnchors, markdownOptions } from '../scripts/conocimiento/markdown.mjs';

const md = new MarkdownIt(markdownOptions);
const originalFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (token.info.trim().toLowerCase() === 'mermaid') {
    return `<pre class="mermaid-source"><code>${md.utils.escapeHtml(token.content)}</code></pre>`;
  }
  return originalFence(tokens, index, options, env, self);
};
// Documents cannot fetch images, run HTML or issue commands through an embedded view.
md.renderer.rules.image = (tokens, index) => `<span class="image-note">[Imagen: ${md.utils.escapeHtml(tokens[index].content)}]</span>`;
const originalLink = md.renderer.rules.link_open || ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const href = token.attrGet('href') ?? '';
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href) && !/^https?:\/\//i.test(href)) token.attrSet('href', '#');
  return originalLink(tokens, index, options, env, self);
};

function taskTokens(source) {
  const tokens = md.parse(source.replace(/^\uFEFF/, ''), {});
  const candidates = [];
  let quoteDepth = 0;
  const listItems = [];
  for (const token of tokens) {
    if (token.type === 'blockquote_open') quoteDepth++;
    if (token.type === 'blockquote_close') quoteDepth--;
    if (token.type === 'list_item_open') listItems.push({ seenInline: false });
    if (token.type === 'list_item_close') listItems.pop();
    if (token.type !== 'inline' || !listItems.length) continue;
    const item = listItems.at(-1);
    if (item.seenInline) continue;
    item.seenInline = true;
    const match = /^\[([ xX])\](?:\s|$)/.exec(token.content);
    if (!quoteDepth && match && token.children?.[0]?.type === 'text') candidates.push({ token, done: match[1].toLowerCase() === 'x' });
  }
  return { tokens, candidates };
}

export function countTasks(source) {
  const { candidates } = taskTokens(source);
  return { total: candidates.length, done: candidates.filter(t => t.done).length };
}

// Plain text of an inline token: text and code spans, without Markdown markers.
function inlineText(token) {
  if (!token?.children) return token?.content || '';
  return token.children.map(child => {
    if (child.type === 'text' || child.type === 'code_inline') return child.content;
    if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
    return '';
  }).join('').replace(/\s+/g, ' ').trim();
}

export function renderDocument(source) {
  const { tokens, candidates } = taskTokens(source);
  const headings = assignHeadingAnchors(tokens).filter(item => item.level >= 2 && item.level <= 4).map(item => ({ id: item.anchor, text: item.label, level: item.level }));
  for (const token of tokens) {
    if (token.map && ['paragraph_open', 'list_item_open'].includes(token.type)) token.attrSet('data-source-line', String(token.map[0] + 1));
  }
  for (const { token, done } of candidates) {
    token.children[0].content = token.children[0].content.replace(/^\[([ xX])\]\s?/, '');
    const checkbox = new token.children[0].constructor('html_inline', '', 0);
    checkbox.content = `<input class="task-checkbox" type="checkbox" disabled${done ? ' checked' : ''} aria-label="${done ? 'Tarea marcada' : 'Tarea pendiente'}"> `;
    token.children.unshift(checkbox);
  }
  return { html: md.renderer.render(tokens, md.options, {}), headings };
}

export function renderMarkdown(source) {
  return renderDocument(source).html;
}

export function documentTitle(source, fallback) {
  const tokens = md.parse(source, {});
  const index = tokens.findIndex(t => t.type === 'heading_open' && t.tag === 'h1');
  return index >= 0 ? tokens[index + 1]?.content || fallback : fallback;
}

function references(tokens, from = 0, to = tokens.length) {
  const links = [];
  const code = [];
  for (let index = from; index < to; index++) {
    for (const child of tokens[index].children || []) {
      if (child.type === 'link_open') links.push(child.attrGet('href') || '');
      if (child.type === 'code_inline') code.push(child.content);
    }
  }
  return { links: links.filter(Boolean), code };
}

// Link destinations and inline code spans, ignoring fenced examples.
export function markdownReferences(source) {
  return references(md.parse(source, {}));
}

// Every heading with the Markdown source of its body, up to the next heading of the same or higher level.
export function markdownSections(source) {
  const lines = source.split(/\r?\n/);
  const tokens = md.parse(source, {});
  const headings = [];
  tokens.forEach((token, index) => {
    if (token.type === 'heading_open' && token.map) headings.push({ index, level: Number(token.tag.slice(1)), start: token.map[0], bodyStart: token.map[1] });
  });
  return headings.map((heading, position) => {
    const next = headings.slice(position + 1).find(candidate => candidate.level <= heading.level);
    const endToken = next ? next.index : tokens.length;
    const endLine = next ? next.start : lines.length;
    let firstParagraph = '';
    const text = [];
    for (let index = heading.index + 2; index < endToken; index++) {
      const token = tokens[index];
      if (token.type !== 'inline') continue;
      text.push(inlineText(token));
      if (!firstParagraph && tokens[index - 1]?.type === 'paragraph_open' && tokens[index - 1].level === 0) firstParagraph = inlineText(token);
    }
    return {
      level: heading.level,
      title: inlineText(tokens[heading.index + 1]),
      body: lines.slice(heading.bodyStart, endLine).join('\n'),
      text: text.join(' '),
      firstParagraph,
      ...references(tokens, heading.index + 2, endToken),
    };
  });
}

// Requirement and scenario counts of an OpenSpec delta spec.
export function deltaCounts(source) {
  const counts = { added: 0, modified: 0, removed: 0, renamed: 0, scenarios: 0 };
  for (const group of specStructure(source).groups) {
    if (group.op) counts[group.op] += group.requirements.length;
    counts.scenarios += group.requirements.reduce((total, requirement) => total + requirement.scenarios.length, 0);
  }
  return counts;
}

// Structured readers use parsed Markdown boundaries, never regexes over generated HTML.
// A quoted or fenced example is not a requirement, scenario or completed task.
function outline(source) {
  const tokens = md.parse(source, {});
  const lines = source.split(/\r?\n/);
  const headings = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'heading_open' && token.level === 0 && token.map) {
      headings.push({ title: inlineText(tokens[index + 1]), level: Number(token.tag.slice(1)), start: token.map[0], body: token.map[1] });
    }
  }
  let note = '';
  const firstQuote = tokens.findIndex(token => token.type === 'blockquote_open' && token.level === 0);
  if (firstQuote >= 0) {
    const end = tokens.findIndex((token, index) => index > firstQuote && token.type === 'blockquote_close' && token.level === 0);
    note = tokens.slice(firstQuote, end < 0 ? tokens.length : end).filter(token => token.type === 'inline').map(inlineText).join(' ');
  }
  return { tokens, lines, headings, note };
}

const glossary = { SHALL: 'obligatorio', MUST: 'obligatorio', SHOULD: 'recomendado', MAY: 'opcional' };
function normativeMarkdown(source) {
  const tokens = md.parse(source, {});
  for (const token of tokens) {
    if (!token.children) continue;
    token.children = token.children.flatMap(child => {
      if (child.type !== 'text') return [child];
      return child.content.split(/\b(SHALL|MUST|SHOULD|MAY)\b/).filter(Boolean).map(text => {
        const replacement = new child.constructor(glossary[text] ? 'html_inline' : 'text', '', 0);
        replacement.content = glossary[text]
          ? `<span class="normative-chip" title="${text}: ${glossary[text]}"><span>${text}</span><span class="normative-gloss">${glossary[text]}</span></span>`
          : text;
        return replacement;
      });
    });
  }
  return md.renderer.render(tokens, md.options, {});
}

function scenarioStructure(body, id, title) {
  const { tokens, lines } = outline(body);
  const steps = [];
  const consumed = new Set();
  let listDepth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'list_item_close') { listDepth--; continue; }
    if (token.type !== 'list_item_open') continue;
    listDepth++;
    if (listDepth !== 1 || !token.map) continue;
    const inline = tokens[index + 2];
    if (inline?.type !== 'inline') continue;
    const match = /^(WHEN|THEN|AND|GIVEN)\b/.exec(inlineText(inline));
    if (!match) continue;
    const raw = lines.slice(token.map[0], token.map[1]);
    const marker = /^(\s*)(?:[-+*]|\d+[.)])\s+/.exec(raw[0]);
    if (!marker) continue;
    const indent = marker[0].length;
    raw[0] = raw[0].slice(indent).replace(/^(?:\*\*|__)?(?:WHEN|THEN|AND|GIVEN)(?:\*\*|__)?\s*/, '');
    for (let line = 1; line < raw.length; line++) raw[line] = raw[line].startsWith(' '.repeat(indent)) ? raw[line].slice(indent) : raw[line];
    steps.push({ keyword: match[1], html: renderMarkdown(raw.join('\n')) });
    for (let line = token.map[0]; line < token.map[1]; line++) consumed.add(line);
  }
  const remainder = lines.filter((_, index) => !consumed.has(index)).join('\n').trim();
  return { id, title, steps, bodyHtml: remainder ? renderMarkdown(remainder) : '' };
}

export function specStructure(source) {
  const { lines, headings, note } = outline(source);
  const groups = [];
  let group = null;
  let serial = 0;
  const groupFor = operation => {
    if (!group || group.op !== operation) {
      group = { id: `spec-group-${groups.length + 1}`, op: operation, requirements: [] };
      groups.push(group);
    }
    return group;
  };
  let operation = null;
  for (let position = 0; position < headings.length; position++) {
    const heading = headings[position];
    if (heading.level <= 2) {
      const match = heading.level === 2 && /^(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i.exec(heading.title);
      operation = match ? match[1].toLowerCase() : null;
      group = null;
      if (operation === 'renamed') {
        const end = headings.slice(position + 1).find(item => item.level <= 2)?.start ?? lines.length;
        // Native OpenSpec also expresses renames as FROM/TO list pairs.
        const renameTokens = md.parse(lines.slice(heading.body, end).join('\n'), {});
        let from = null;
        for (let index = 0; index < renameTokens.length; index++) {
          const token = renameTokens[index];
          if (token.type !== 'inline' || renameTokens[index - 1]?.type !== 'paragraph_open' || renameTokens[index - 1].level !== 2) continue;
          const pair = /^(FROM|TO):\s*(?:Requirement:\s*)?(.+)$/i.exec(inlineText(token));
          if (pair?.[1].toUpperCase() === 'FROM') from = pair[2];
          else if (pair?.[1].toUpperCase() === 'TO' && from) {
            groupFor('renamed').requirements.push({ id: `requirement-${++serial}`, title: `${from} → ${pair[2]}`, statementHtml: renderMarkdown(`De ${from}\n\nA ${pair[2]}`), scenarios: [], from, to: pair[2] });
            from = null;
          }
        }
      }
      continue;
    }
    if (heading.level !== 3 || !/^Requirement\s*:/i.test(heading.title)) continue;
    const endPosition = headings.findIndex((item, index) => index > position && item.level <= 3);
    const endLine = endPosition < 0 ? lines.length : headings[endPosition].start;
    const scenarioHeadings = headings.slice(position + 1, endPosition < 0 ? headings.length : endPosition).filter(item => item.level === 4 && /^Scenario\s*:/i.test(item.title));
    const id = `requirement-${++serial}`;
    const requirement = {
      id, title: heading.title.replace(/^Requirement\s*:\s*/i, ''),
      statementHtml: normativeMarkdown(lines.slice(heading.body, scenarioHeadings[0]?.start ?? endLine).join('\n')),
      scenarios: scenarioHeadings.map((scenario, index) => scenarioStructure(lines.slice(scenario.body, scenarioHeadings[index + 1]?.start ?? endLine).join('\n'), `${id}-scenario-${index + 1}`, scenario.title.replace(/^Scenario\s*:\s*/i, ''))),
    };
    groupFor(operation).requirements.push(requirement);
  }
  return { note, groups: groups.filter(item => item.requirements.length > 0) };
}

export function tasksStructure(source) {
  const { headings, note } = outline(source);
  const { candidates } = taskTokens(source);
  const sections = [];
  for (const candidate of candidates) {
    const preceding = headings.filter(heading => heading.start < (candidate.token.map?.[0] ?? Infinity) && heading.level <= 2).at(-1);
    const heading = preceding?.level === 2 ? preceding : null;
    const key = heading?.start ?? -1;
    let section = sections.find(item => item.key === key);
    if (!section) {
      section = { key, id: `tasks-section-${sections.length + 1}`, title: heading?.title || 'Tareas', items: [], done: 0, total: 0 };
      sections.push(section);
    }
    const raw = candidate.token.content.replace(/^\[([ xX])\]\s?/, '');
    section.items.push({ text: inlineText(candidate.token).replace(/^\[([ xX])\]\s?/, ''), html: renderMarkdown(raw), done: candidate.done });
    section.total++;
    if (candidate.done) section.done++;
  }
  return { note, sections: sections.map(({ key, ...section }) => section), total: candidates.length, done: candidates.filter(candidate => candidate.done).length };
}

// Search is plain text only. Fenced code and images are deliberately not indexed.
export function searchableText(source) {
  return md.parse(source, {}).filter(token => token.type === 'inline').map(inlineText).filter(Boolean).join('\n');
}

export function countDiagrams(source) {
  return md.parse(source, {}).filter(token => token.type === 'fence' && token.info.trim().toLowerCase() === 'mermaid').length;
}

// Index tables used by actual S0 templates: intention | first document | when to read.
export function tableIntents(source) {
  const rows = [];
  let row = null;
  let cell = null;
  let inBody = false;
  for (const token of md.parse(source, {})) {
    if (token.type === 'tbody_open') inBody = true;
    if (token.type === 'tbody_close') inBody = false;
    if (!inBody) continue;
    if (token.type === 'tr_open') row = [];
    if (token.type === 'td_open') cell = { text: '', links: [] };
    if (token.type === 'inline' && cell) { cell.text = inlineText(token); cell.links = references([token]).links; }
    if (token.type === 'td_close' && row && cell) { row.push(cell); cell = null; }
    if (token.type === 'tr_close' && row) { if (row.length >= 2 && row[0].text) rows.push({ title: row[0].text, description: row.slice(2).map(item => item.text).join(' '), href: row.slice(1).flatMap(item => item.links)[0] || null }); row = null; }
  }
  return rows;
}
