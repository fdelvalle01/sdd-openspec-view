import test from 'node:test';
import assert from 'node:assert/strict';
import { countDiagrams, deltaCounts, markdownReferences, markdownSections, renderDocument, renderMarkdown, searchableText, specStructure, tableIntents, tasksStructure } from '../src/markdown.js';

test('raw HTML and executable Markdown destinations remain inert', () => {
  const html = renderMarkdown([
    '<script>alert("html")</script>',
    '<img src=x onerror="alert(1)">',
    '<iframe src="https://example.test"></iframe>',
    '[script](javascript:alert%281%29)',
    '[encoded](jav&#x61;script:alert%281%29)',
    '[data](data:text/html;base64,PHNjcmlwdD4=)',
    '![svg](data:image/svg+xml;base64,PHN2Zz4=)',
  ].join('\n\n'));
  assert.doesNotMatch(html, /<(?:script|img|iframe)\b/i);
  assert.doesNotMatch(html, /(?:href|src)\s*=\s*["']\s*(?:javascript|vbscript|data):/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});

test('ordinary code fences preserve literal code instead of rendering its content', () => {
  const html = renderMarkdown('```html\n<script>alert(1)</script>\n[link](https://example.test)\n```');
  assert.match(html, /<pre><code\b/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script\b|<a\b/i);
  assert.match(html, /\[link\]\(https:\/\/example\.test\)/);
});

test('Mermaid fences expose escaped source for the isolated diagram renderer', () => {
  const html = renderMarkdown('```mermaid\nflowchart LR\n A["<img src=x onerror=alert(1)>"] --> B["& done"]\n```');
  assert.match(html, /<pre\b[^>]*class=["']mermaid-source["'][^>]*><code\b/);
  assert.match(html, /flowchart LR/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&amp; done/);
  assert.doesNotMatch(html, /<img\b|<script\b|<svg\b/i);
});

test('tables and task lists render with disabled checkboxes', () => {
  const html = renderMarkdown([
    '| Artifact | State |',
    '| --- | --- |',
    '| Proposal | Ready |',
    '',
    '- [x] Complete',
    '- [ ] Pending',
  ].join('\n'));
  assert.match(html, /<table>/);
  assert.match(html, /<th>Artifact<\/th>/);
  const inputs = html.match(/<input\b[^>]*>/gi) ?? [];
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.match(input, /\btype=["']checkbox["']/i);
    assert.match(input, /\bdisabled(?:\s|=|\/?>)/i);
  }
  assert.equal(inputs.filter(input => /\bchecked(?:\s|=|\/?>)/i.test(input)).length, 1);
});

test('rendered documents list h2 to h4 headings with unique ids', () => {
  const { html, headings } = renderDocument('# Título\n\n## Uso\n\n### Uso\n\n#### **Caso** `x`\n\n##### Nota\n\n```md\n## No es encabezado\n```\n');
  assert.deepEqual(headings, [{ id: 'uso', text: 'Uso', level: 2 }, { id: 'uso-1', text: 'Uso', level: 3 }, { id: 'caso-x', text: 'Caso x', level: 4 }]);
  assert.match(html, /<h3 id="uso-1">/);
  assert.equal(renderMarkdown('## Uso'), renderDocument('## Uso').html);
});

test('sections keep their Markdown body until the next heading of the same level', () => {
  const sections = markdownSections('# Doc\n\nIntro.\n\n## Uno\n\nPrimer párrafo con `code` y [link](a.md).\n\n### Sub\n\nTexto.\n\n## Dos\n\n> Cita.\n\nDespués de la cita.\n');
  const [, uno, sub, dos] = sections;
  assert.equal(uno.title, 'Uno');
  assert.match(uno.body, /### Sub/);
  assert.equal(uno.firstParagraph, 'Primer párrafo con code y link.');
  assert.deepEqual(uno.links, ['a.md']);
  assert.deepEqual(uno.code, ['code']);
  assert.equal(sub.level, 3);
  assert.equal(dos.firstParagraph, 'Después de la cita.');
  assert.deepEqual(markdownReferences('Ver [x](x.md).\n\n```\n[no](y.md)\n```').links, ['x.md']);
});

test('delta counts only requirement headings under OpenSpec operations', () => {
  const source = '# Delta\n\n## ADDED Requirements\n\n### Requirement: A\n\n#### Scenario: A1\n\n### Requirement: B\n\n## REMOVED Requirements\n\n### Requirement: C\n\n## Notas\n\n### Requirement: fuera de operación\n\n```md\n### Requirement: ejemplo\n```\n';
  assert.deepEqual(deltaCounts(source), { added: 2, modified: 0, removed: 1, renamed: 0, scenarios: 1 });
});

test('structured specs retain normative statements, notes and scenario details without executing HTML', () => {
  const parsed = specStructure('# Search\n\n> Laboratory fixture, not approval.\n\n## ADDED Requirements\n\n### Requirement: Query\n\nThe service SHALL support **query** and MAY return `<raw>`.\n\n<script>alert(1)</script>\n\n#### Scenario: Match\n\nContext before steps.\n\n- **GIVEN** a [catalog](catalog.md)\n- **WHEN** the query is `<script>`\n- **THEN** results appear\n  - Nested detail\n- **AND** the selection is retained\n\nAfter the steps.\n');
  assert.equal(parsed.note, 'Laboratory fixture, not approval.');
  assert.equal(parsed.groups[0].op, 'added');
  const requirement = parsed.groups[0].requirements[0];
  assert.equal(requirement.title, 'Query');
  assert.match(requirement.statementHtml, /class="normative-chip"[^>]*title="SHALL: obligatorio"/);
  assert.match(requirement.statementHtml, /MAY: opcional/);
  assert.doesNotMatch(requirement.statementHtml, /<script\b/);
  const scenario = requirement.scenarios[0];
  assert.deepEqual(scenario.steps.map(step => step.keyword), ['GIVEN', 'WHEN', 'THEN', 'AND']);
  assert.match(scenario.steps[0].html, /href="catalog.md"/);
  assert.match(scenario.steps[1].html, /&lt;script&gt;/);
  assert.match(scenario.steps[2].html, /Nested detail/);
  assert.match(scenario.bodyHtml, /Context before steps/);
  assert.match(scenario.bodyHtml, /After the steps/);
  assert.doesNotMatch(scenario.bodyHtml, /Nested detail/);
});

test('structured readers ignore quoted and fenced headings and keep consolidated requirements', () => {
  const source = '# Catalog\n\n> ### Requirement: Example\n> #### Scenario: Quoted\n\n```md\n### Requirement: Fenced\n#### Scenario: Fenced\n```\n\n## Requirements\n\n### Requirement: List\n\nThe UI MUST show records, SHOULD explain an empty result. `MUST` is literal code.\n\n#### Scenario: Empty\n\n- WHEN there are no records\n- THEN show a notice\n';
  const structure = specStructure(source);
  assert.equal(structure.groups.length, 1);
  assert.equal(structure.groups[0].op, null);
  assert.equal(structure.groups[0].requirements.length, 1);
  const requirement = structure.groups[0].requirements[0];
  assert.equal(requirement.scenarios.length, 1);
  assert.equal(requirement.scenarios[0].steps.length, 2);
  assert.match(requirement.statementHtml, /<code>MUST<\/code>/);
  assert.equal((requirement.statementHtml.match(/class="normative-chip"/g) || []).length, 2);
});

test('native FROM TO renames are counted, malformed unmatched pairs are not invented', () => {
  const source = '## RENAMED Requirements\n\n- FROM: `Requirement: Old search`\n- TO: `Requirement: Search`\n- FROM: `Requirement: Incomplete`\n\n> - TO: `Requirement: Quoted`\n\n```md\n- FROM: false\n- TO: false\n```\n\n## MODIFIED Requirements\n\n### Requirement: Sort\n\nMUST retain ordering.\n\n#### Scenario: Match\n\n- **THEN** retain ordering\n';
  assert.deepEqual(deltaCounts(source), { added: 0, modified: 1, removed: 0, renamed: 1, scenarios: 1 });
  const renamed = specStructure(source).groups[0].requirements[0];
  assert.equal(renamed.from, 'Old search');
  assert.equal(renamed.to, 'Search');
  assert.deepEqual(renamed.scenarios, []);
});

test('malformed specs produce no invented requirements or orphan scenarios', () => {
  const source = '# Incomplete\n\n## ADDED Requirements\n\n#### Scenario: Orphan\n\n- **WHEN** no requirement exists\n';
  assert.deepEqual(specStructure(source), { note: '', groups: [] });
  assert.deepEqual(deltaCounts(source), { added: 0, modified: 0, removed: 0, renamed: 0, scenarios: 0 });
});

test('structured tasks keep H2 grouping and Markdown while excluding example checkboxes', () => {
  const source = '# Tasks\n\n> Test fixture only.\n\n- [ ] Before sections\n\n## 1. Implement\n\n- [x] Handle **empty** lists\n  - [ ] Preserve nested detail\n- [ ] Escape `<script>`\n\n## 2. Verify\n\n> - [x] Example in quote\n\n```md\n- [x] Example in fence\n```\n\n- [ ] Run tests\n';
  const parsed = tasksStructure(source);
  assert.equal(parsed.note, 'Test fixture only.');
  assert.equal(parsed.total, 5);
  assert.equal(parsed.done, 1);
  assert.deepEqual(parsed.sections.map(section => section.title), ['Tareas', '1. Implement', '2. Verify']);
  assert.deepEqual(parsed.sections.map(section => [section.done, section.total]), [[0, 1], [1, 3], [0, 1]]);
  assert.match(parsed.sections[1].items[0].html, /<strong>empty<\/strong>/);
  assert.match(parsed.sections[1].items[2].html, /&lt;script&gt;/);
  assert.doesNotMatch(JSON.stringify(parsed), /<input\b/);
});

test('plain text search includes inline code, headings and prose but not fenced commands', () => {
  assert.equal(searchableText('# Catalog\n\nSearch **records** with `query`.\n\n```sh\nsecret-in-fence\n```\n\n![image](https://example.test/private.png)'), 'Catalog\nSearch records with query.');
});

test('index tables expose the intention, its first link and consultation criteria', () => {
  const source = '# Index\n\n| Need | Document | When |\n| --- | --- | --- |\n| Analyze **HU** | [Guide](guide.md), [map](map.md) | Before a change |\n| Review | No link yet | If requested |\n';
  assert.deepEqual(tableIntents(source), [
    { title: 'Analyze HU', href: 'guide.md', description: 'Before a change' },
    { title: 'Review', href: null, description: 'If requested' },
  ]);
});

test('diagram counts come from actual Mermaid fences including quoted diagrams, not examples in other fences', () => {
  const source = '# Design\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n> ```MERMAID\n> graph TD\n> X-->Y\n> ```\n\n````md\n```mermaid\nA-->B\n```\n````\n\n`mermaid`\n\n```mermaid extra-options\nA-->B\n```\n';
  assert.equal(countDiagrams(source), 2);
  assert.equal(countDiagrams('# No diagrams\n'), 0);
});
