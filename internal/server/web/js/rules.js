import { RULE_ARTICLES, RULE_BY_ID, RULE_CATEGORIES, RULE_VERSION, QUICK_RULES } from './rules-data.js';
import { closeModal, openModal } from './modal.js';

const $ = s => document.querySelector(s);
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

const textOf = value => {
  if (Array.isArray(value)) return value.map(textOf).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map(textOf).join(' ');
  return String(value == null ? '' : value);
};

const normalized = value => String(value || '').toLowerCase().replace(/[\s·，。、“”‘’：；（）()/_-]+/g, '');

export function searchRules(query) {
  const q = normalized(query);
  if (!q) return [];
  return RULE_ARTICLES.map(item => {
    const title = normalized(item.title);
    const keywords = normalized(item.keywords.join(' '));
    const body = normalized(item.summary + ' ' + textOf(item.blocks));
    let score = 0;
    if (title === q) score += 100;
    if (title.includes(q)) score += 50;
    if (keywords.includes(q)) score += 25;
    if (body.includes(q)) score += 10;
    return { item, score };
  }).filter(hit => hit.score > 0).sort((x, y) => y.score - x.score || x.item.title.localeCompare(y.item.title, 'zh-CN'))
    .map(hit => hit.item);
}

let state = { category: 'score', article: 'score-overview', query: '' };

const categoryOf = id => RULE_CATEGORIES.find(category => category.articles.includes(id)) || RULE_CATEGORIES[0];

function renderBlock(block) {
  if (block.type === 'note') return `<div class="rule-note"><b>${esc(block.title)}</b><p>${esc(block.text)}</p></div>`;
  if (block.type === 'steps') return `<section class="rule-block"><h3>${esc(block.title)}</h3><ol class="rule-steps">${block.items.map((item, i) => `<li><span>${i + 1}</span><p>${esc(item)}</p></li>`).join('')}</ol></section>`;
  if (block.type === 'list') return `<section class="rule-block"><h3>${esc(block.title)}</h3><ul>${block.items.map(item => `<li>${esc(item)}</li>`).join('')}</ul></section>`;
  if (block.type === 'facts' || block.type === 'formula') return `<section class="rule-block"><h3>${esc(block.title)}</h3><dl class="rule-facts${block.type === 'formula' ? ' formula' : ''}">${block.items.map(([term, desc]) => `<div><dt>${esc(term)}</dt><dd>${esc(desc)}</dd></div>`).join('')}</dl></section>`;
  if (block.type === 'table') return `<section class="rule-block"><h3>${esc(block.title)}</h3><div class="rule-table-wrap"><table><thead><tr>${block.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
  return '';
}

export function renderRuleArticle(item) {
  const category = categoryOf(item.id);
  return `<article class="rule-article" data-rule-article="${esc(item.id)}">
    <div class="rule-kicker">${esc(category.label)}</div>
    <h2>${esc(item.title)}</h2>
    <p class="rule-summary">${esc(item.summary)}</p>
    ${item.blocks.map(renderBlock).join('')}
    <footer class="rule-source"><span>官方依据</span>${esc(item.source)}</footer>
  </article>`;
}

function renderSearchResults(query) {
  const hits = searchRules(query);
  if (!hits.length) return `<div class="rule-empty"><b>没有找到“${esc(query)}”</b><span>可搜索分数、评选、身份、技能或版型。</span></div>`;
  return `<div class="rule-results"><div class="rule-result-count">找到 ${hits.length} 条相关规则</div>${hits.map(item => {
    const category = categoryOf(item.id);
    return `<button class="rule-result" data-rule-open="${esc(item.id)}"><span>${esc(category.label)}</span><b>${esc(item.title)}</b><p>${esc(item.summary)}</p></button>`;
  }).join('')}</div>`;
}

function renderRules() {
  const root = $('#rules');
  if (!root) return;
  const activeCategory = RULE_CATEGORIES.find(category => category.id === state.category) || RULE_CATEGORIES[0];
  const item = RULE_BY_ID[state.article] || RULE_BY_ID[activeCategory.articles[0]];
  const categoryTabs = RULE_CATEGORIES.map(category => `<button class="rule-tab${category.id === activeCategory.id ? ' on' : ''}" data-rule-category="${category.id}"><b>${esc(category.label)}</b><span>${esc(category.description)}</span></button>`).join('');
  const index = activeCategory.articles.map(id => `<button class="rule-index-item${id === item.id && !state.query ? ' on' : ''}" data-rule-open="${esc(id)}">${esc(RULE_BY_ID[id].title)}</button>`).join('');
  const quick = QUICK_RULES.map(([id, label]) => `<button data-rule-open="${id}">${esc(label)}</button>`).join('');
  const content = state.query ? renderSearchResults(state.query) : renderRuleArticle(item);
  root.innerHTML = `<div class="rules-card">
    <header class="rules-head">
      <div><div id="rules-title" class="rules-title"><span>华山规则</span><b>速查</b></div><p>官方选手执行手册 ${RULE_VERSION} · 按主题速查</p></div>
      <button class="rules-close" data-rules-close>关闭</button>
    </header>
    <div class="rules-tools">
      <label class="rules-search"><span>⌕</span><input data-rules-search value="${esc(state.query)}" placeholder="搜索分数、评选、身份、技能或版型" autocomplete="off"><kbd>Esc</kbd></label>
      <div class="rules-quick"><span>快速查询</span>${quick}</div>
    </div>
    <nav class="rule-tabs">${categoryTabs}</nav>
    <div class="rules-layout">
      <aside class="rule-index"><div class="rule-index-label">${esc(activeCategory.label)}</div>${index}</aside>
      <main class="rules-content">${content}</main>
    </div>
  </div>`;
  const input = root.querySelector('[data-rules-search]');
  if (input && state.query) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

export function showRules(articleId = '') {
  const root = $('#rules');
  if (!root) return;
  if (articleId && RULE_BY_ID[articleId]) {
    state.article = articleId;
    state.category = categoryOf(articleId).id;
  }
  state.query = '';
  renderRules();
  openModal(root, { onClose: closeRules, labelledBy: 'rules-title', focusSelector: '[data-rules-search]' });
}

export function closeRules() {
  const root = $('#rules');
  if (!root) return;
  closeModal(root);
  root.innerHTML = '';
}

function openRule(id) {
  const item = RULE_BY_ID[id];
  if (!item) return;
  state = { category: item.category, article: id, query: '' };
  renderRules();
  const content = $('.rules-content'); if (content) content.scrollTop = 0;
}

function setCategory(id) {
  const category = RULE_CATEGORIES.find(item => item.id === id);
  if (!category) return;
  state = { category: id, article: category.articles[0], query: '' };
  renderRules();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', event => {
    const openButton = event.target.closest('#rules-open');
    if (openButton) { showRules(); return; }
    const root = event.target.closest('#rules');
    if (!root) return;
    if (event.target === root || event.target.closest('[data-rules-close]')) { closeRules(); return; }
    const article = event.target.closest('[data-rule-open]');
    if (article) { openRule(article.dataset.ruleOpen); return; }
    const category = event.target.closest('[data-rule-category]');
    if (category) setCategory(category.dataset.ruleCategory);
  });

  document.addEventListener('input', event => {
    if (!event.target.matches('[data-rules-search]')) return;
    state.query = event.target.value.trim();
    const content = $('.rules-content');
    if (content) content.innerHTML = state.query ? renderSearchResults(state.query) : renderRuleArticle(RULE_BY_ID[state.article]);
  });
}
