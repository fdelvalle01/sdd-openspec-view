import MarkdownIt from 'markdown-it';
import { createKnowledgeEngine } from '../scripts/conocimiento/index.mjs';

// Bundled at build time. Never import or execute scripts from the selected S0.
const engine = createKnowledgeEngine(MarkdownIt);
export const buildKnowledgeIndex = (root, options = {}) => engine.buildIndex(root, options);
export const queryKnowledge = (index, options = {}) => engine.query(index, options);
