import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RULE_ARTICLES, RULE_BY_ID, RULE_CATEGORIES, RULE_VERSION } from '../internal/server/web/js/rules-data.js';
import { renderRuleArticle, searchRules } from '../internal/server/web/js/rules.js';

test('规则内容覆盖四个分类且所有索引可定位', () => {
  assert.equal(RULE_VERSION, '2026.9.9');
  assert.deepEqual(RULE_CATEGORIES.map(c => c.id), ['score', 'game', 'edition', 'discipline']);
  for (const category of RULE_CATEGORIES) {
    assert.ok(category.articles.length > 0);
    for (const id of category.articles) assert.equal(RULE_BY_ID[id].category, category.id);
  }
});

test('计分和评选是默认分类的主要内容', () => {
  const score = RULE_CATEGORIES[0].articles;
  for (const id of ['score-overview', 'review-good', 'review-wolf', 'life-good', 'vote-score', 'skill-score']) {
    assert.ok(score.includes(id));
  }
});

test('搜索按标题、关键词和正文找到规则', () => {
  assert.equal(searchRules('MVP')[0].id, 'review-good');
  assert.ok(searchRules('投票分').some(x => x.id === 'vote-score'));
  assert.ok(searchRules('同守同救').some(x => x.id === 'edition-detective'));
  assert.ok(searchRules('石像鬼').some(x => x.id === 'edition-gargoyle'));
  assert.ok(searchRules('重大失误').some(x => x.id === 'discipline-major'));
  assert.ok(searchRules('彩蛋').some(x => x.id === 'score-overview'));
  assert.ok(searchRules('侦探警犬').some(x => x.id === 'edition-detective'));
  assert.deepEqual(searchRules('完全不存在的内容'), []);
});

test('每条规则包含摘要、官方依据和可渲染内容', () => {
  for (const item of RULE_ARTICLES) {
    assert.ok(item.summary);
    assert.match(item.source, /手册第/);
    assert.ok(item.blocks.length > 0);
    const html = renderRuleArticle(item);
    assert.match(html, new RegExp(item.title));
    assert.match(html, /官方依据/);
  }
});

test('规则速查只收录牌局判定与单局得分相关内容', () => {
  const publicText = JSON.stringify(RULE_ARTICLES);
  assert.doesNotMatch(publicText, /报名|赛程|奖励|奖金|迟到|换人/);
});

test('规则入口和独立样式已接入页面', () => {
  const html = readFileSync('./internal/server/web/index.html', 'utf8');
  assert.match(html, /id="rules-open"/);
  assert.match(html, /id="rules"/);
  assert.match(html, /href="rules\.css"/);
  assert.match(html, /src="js\/rules\.js"/);
});
