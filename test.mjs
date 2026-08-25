// 前端单元测试：直接 import ES 模块（无需 vm/正则抽取）。运行：node --test test.mjs
// 计算类逻辑（聚合/筛选/候选/阵营归类/分页）已下沉到 Go(internal/player)，相应用例见 player_test.go；
// 这里只测“展示层”：配色、技能/投票/标记文案、赛区名解析、HTML 构造器、以及只连本地的 api 薄壳。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  skillLabel, roleColor, roleWeight, campColor, seatVotes, seatSkills, skillText, uniq, isWolf, resolveZone, fmt, isGoodCamp,
} from './internal/server/web/js/format.js';
import { renderDetailHTML, renderGameHTML, detailLoadingHTML, gateHTML, showGate, enterApp, prefetchPlayer, rankByRelevance } from './internal/server/web/js/ui.js';
import { searchPlayers, detail, game, eventCatalog, eventSeasons, eventAvailability, eventRankings, eventRankAggregate, eventTeam, latest, refreshSession, setManualToken, currentToken, setAuthLostHandler, tokenValid, sessionReason, appVersion, startHeartbeat, stopHeartbeat, quitApp } from './internal/server/web/js/api.js';
import { cmpVer, autoCheckUpdate, shareText, showAbout } from './internal/server/web/js/options.js';
import { renderEventsHTML, renderEventTeamHTML, syncEventFilters, queryEvents, showHome, showPersonal, showTools, showEventTeam, closeEventTeam, __setEventsState } from './internal/server/web/js/events.js';

const styles = readFileSync(new URL('./internal/server/web/styles.css', import.meta.url), 'utf8');

test('浅色主题：筛选框和战绩标识使用浅色背景', () => {
  assert.match(styles, /\[data-theme=light\] input,\[data-theme=light\] select\{[^}]*background:#ffffff;[^}]*color:var\(--fg\)/);
  for (const mark of ['mvp', 'svp', 'bgx']) {
    assert.match(styles, new RegExp(`\\[data-theme=light\\] \\.gm\\.${mark}\\{[^}]*background:[^;}]+;[^}]*color:[^;}]+;`));
  }
});

test('skillLabel：固定动词的角色 + 其余按角色名自动拆前缀', () => {
  assert.equal(skillLabel('狼刀', '狼'), '刀');
  assert.equal(skillLabel('狼刀', '狼王'), '刀');   // 席位狼王、技能名“狼刀” → 回退角色词表
  assert.equal(skillLabel('女巫解', '女巫'), '救');   // 特殊：解→救
  assert.equal(skillLabel('女巫毒', '女巫'), '毒');   // 自动拆：女巫毒→毒
  assert.equal(skillLabel('侦探翻', '侦探'), '翻牌');
  assert.equal(skillLabel('警犬验', '警犬'), '验');
  assert.equal(skillLabel('预言家', '预言家'), '验');
  assert.equal(skillLabel('摄梦人', '摄梦人'), '摄');
  assert.equal(skillLabel('猎人', '猎人'), '带');
  assert.equal(skillLabel('猎人开枪', '猎人'), '带');   // 角色固定动词优先
  assert.equal(skillLabel('守卫', '守卫'), '守');
  // 技能名=角色名会拆空 / 拆歪的角色：按技能名显式给动词（依据规则手册）
  assert.equal(skillLabel('梦魇', '梦魇'), '恐惧');
  assert.equal(skillLabel('狼美人', '狼美人'), '魅惑');
  assert.equal(skillLabel('猎魔人', '猎魔人'), '狩猎');
  assert.equal(skillLabel('石像鬼', '石像鬼'), '查验');
  assert.equal(skillLabel('骑士骑', '骑士'), '决斗');
  // 梦魇/狼美人行里的“狼刀”条目仍按狼刀处理（不被本角色动词吃掉）；石像鬼后期猎杀也记在狼刀名下
  assert.equal(skillLabel('狼刀', '梦魇'), '刀');
  assert.equal(skillLabel('狼刀', '狼美人'), '刀');
  assert.equal(skillLabel('狼刀', '石像鬼'), '刀');   // 石像鬼最后一天猎杀=狼刀（本角色技能名恒为查验）
});

test('roleColor / roleWeight：平民灰、狼阵营(含石像鬼/血月使徒)红、神职珠宝色', () => {
  assert.equal(roleColor('狼'), '#ff6b6b');
  assert.equal(roleColor('狼王'), '#ff2d2d');
  assert.equal(roleColor('白狼王'), '#ff9463');
  assert.equal(roleColor('石像鬼'), '#d6604a');   // 第三方→狼阵营红
  assert.equal(roleColor('血月使徒'), '#a8324a');
  assert.equal(roleColor('梦魇'), '#b5495b');       // 无“狼”字的狼阵营身份也为红系
  assert.equal(roleColor('怪盗狼王'), '#ff5a5f');
  assert.equal(roleColor('平民'), '#93a1b2');
  assert.equal(roleColor('预言家'), '#5aa2f5');
  assert.equal(roleColor('某未知神'), '#5aa2f5');  // 默认神职
  assert.equal(roleWeight('平民'), '');
  assert.equal(roleWeight('石像鬼'), ';font-weight:700');
});

test('campColor：牌局弹层收敛为阵营三色（狼红/神蓝/民灰），不分细分身份', () => {
  assert.equal(campColor('平民'), 'var(--sub)');
  assert.equal(campColor('狼'), 'var(--danger)');
  assert.equal(campColor('狼王'), 'var(--danger)');       // 各类狼统一红
  assert.equal(campColor('石像鬼'), 'var(--danger)');     // 狼阵营第三方同红
  assert.equal(campColor('梦魇'), 'var(--danger)');
  assert.equal(campColor('预言家'), 'var(--blue)');       // 神职统一蓝
  assert.equal(campColor('女巫'), 'var(--blue)');
  assert.equal(campColor('某未知神'), 'var(--blue)');
});

test('seatVotes：投 0 / 空不显示，含警徽票', () => {
  const s = { vote_day1: '6', vote_day2: '0', vote_day3: '', vote_jinhui: 11 };
  assert.equal(seatVotes(s, 3), 'D1→6　警徽→11');
  assert.equal(seatVotes({ vote_day1: '5', vote_jinhui: 0 }, 1), 'D1→5');
  assert.equal(seatVotes({ vote_day1: '0' }, 3), '—');
});

test('seatSkills：只取有目标的技能，动作+目标座位', () => {
  const seer = { rpt_name: '女巫', skills: [
    { day: 1, name: '女巫解', target_seats: [9] },
    { day: 2, name: '女巫毒', target_seats: [4] },
    { day: 3, light: false, target_seat: 0 },
  ]};
  assert.equal(seatSkills(seer), 'D1 救→9　D2 毒→4');
  const prophet = { rpt_name: '预言家', skills: [
    { day: 1, name: '预言家', target_seats: [3] },
    { day: 2, name: '预言家', target_seats: [7] },
  ]};
  assert.equal(seatSkills(prophet), 'D1 验→3　D2 验→7');
  assert.equal(seatSkills({ rpt_name: '平民', skills: [] }), '—');
});

test('skillText：怪盗狼王对自己=顶盾(无号)，对他人/其他角色=动词→座位', () => {
  assert.equal(skillText({ name: '怪盗', day: 1, target_seats: [5] }, '怪盗狼王', 5), '顶盾');
  assert.equal(skillText({ name: '怪盗', day: 1, target_seats: [8] }, '怪盗狼王', 5).endsWith('→8'), true);
  assert.equal(skillText({ name: '狼刀', day: 1, target_seats: [5] }, '狼', 5), '刀→5');
  assert.equal(skillText({ name: '怪盗', day: 1, target_seats: ['5'] }, '怪盗狼王', 5), '顶盾');
});

test('seatSkills：怪盗狼王自己发动 → D1 顶盾（无箭头号码）', () => {
  const s = { rpt_name: '怪盗狼王', seat: 5, skills: [{ day: 1, name: '怪盗', target_seats: [5] }] };
  assert.equal(seatSkills(s), 'D1 顶盾');
});

test('resolveZone：赛区中文名/代码/全部 → 代码（显式传入 joined）', () => {
  const joined = [{ ordering: 'SD', text: '山东赛区' }, { ordering: 'BJ', text: '北京赛区' }];
  assert.equal(resolveZone('山东赛区', joined), 'SD');
  assert.equal(resolveZone('SD', joined), 'SD');
  assert.equal(resolveZone('北京', joined), 'BJ');
  assert.equal(resolveZone('', joined), 'ALL');
  assert.equal(resolveZone('全部赛区', joined), 'ALL');
  assert.equal(resolveZone('查无此区', joined), 'ALL');
});

test('uniq / isWolf 辅助', () => {
  assert.deepEqual(uniq([1, 1, 2, 3, 3, 2]), [1, 2, 3]);
  assert.equal(isWolf('狼王'), true);
  assert.equal(isWolf('平民'), false);
});

test('fmt：字段名+数值 → 中文标签 + 百分号；缺失显示 —（标签是页面的活，Go 只给 key/val）', () => {
  assert.deepEqual(fmt('win_pct', 37), { name: '胜率', val: '37%' });
  assert.deepEqual(fmt('total_point', 10), { name: '总分', val: 10 });
  assert.deepEqual(fmt('total_point', null), { name: '总分', val: '—' });
  assert.equal(fmt('unknown_pct', 5).val, '5%');
});

test('isGoodCamp：好人=非狼且非第三方（逐场表阵营快捷筛选用）', () => {
  assert.equal(isGoodCamp('平民'), true);
  assert.equal(isGoodCamp('预言家'), true);
  assert.equal(isGoodCamp('狼'), false);
  assert.equal(isGoodCamp('石像鬼'), false);
  assert.equal(isGoodCamp('梦魇'), false);
});

// —— 纯 HTML 构造器：renderDetailHTML 消费 Go 的数值模型 + 页面本地交互态 ——
// model = 后端 DetailView（聚合为 KV 数值、逐场为作用域原始行）；state 包裹它 + gf/sort/roleSort/limit
const model = over => ({
  player: { id: 7, name: '张三', avatar: '' },
  zone: 'ALL', season: '', sect: '',
  power: 1234,
  joined: [{ ordering: 'SD', text: '山东赛区' }],
  honors: [{ zone_id: 'SD', season_id: 6, code: '1' }],
  teams: ['门派A'],
  comprehensive: [{ key: 'round_total', val: 1 }, { key: 'round_point_avg', val: 5 }, { key: 'win_pct', val: 100 }],
  good: [{ key: 'toulang_pct', val: 10 }, { key: 'zhanbian_pct', val: 80 }], wolf: [],
  roles: [{ role: '平民', n: 1, avg: 5, win: 100, mvp: 1, svp: 0, bgx: 0 }],
  editions: [{ edition: '狼王摄梦人', n: 1, avg: 5, win: 100, mvp: 1, svp: 0, bgx: 0 }],
  season_cands: [6], sect_cands: ['门派A'],
  games: [{ game_id: 11, play_date: '2024-01-01', season_id: 6, round: 1, seat: 3, sect_name: '门派A', rpt_name: '平民', total_point: 5, win: 1, mvp: 1, svp: 0, bgx: 0 }],
  games_trunc: false, stats_error: '', games_error: '',
  ...over,
});
const state = over => {
  const { model: mOver, ...rest } = over;
  return {
    id: 7, gf: { result: '', camp: '', role: '', sect: '', mark: '' },
    sort: { key: 'play_date', dir: -1 }, roleSort: { key: 'n', dir: -1 }, limit: 20,
    ...rest, model: model(mOver || {}),
  };
};

test('renderDetailHTML：个人头部、概览与按需切换的详情页签完整渲染', () => {
  const html = renderDetailHTML(state({}));
  assert.match(html, /张三/);
  assert.match(html, /1234/);              // 战力值（原样数值）
  assert.match(html, /门派A/);
  assert.match(html, /个人数据分类/);
  assert.doesNotMatch(html, /openGame\(11\)/);
  assert.match(html, /🎯 综合/);
  const edition = renderDetailHTML(state({ detailTab: 'editions' }));
  assert.match(edition, /🧩 版型表现/);
  assert.match(edition, /狼王摄梦人/);
  const games = renderDetailHTML(state({ detailTab: 'games' }));
  assert.match(games, /openGame\(11\)/);
  assert.match(games, /共 1 场/);
  assert.match(html, /总场次/);            // fmt 把 round_total 译成中文标签（页面做）
  assert.match(html, /山东 S6 冠军/);       // zoneName(SD,joined)→山东赛区→去“赛区”；code 1→冠军
  assert.match(html, /100%/);              // 胜率由 comprehensive.win_pct 现格式化
  assert.match(html, /10%/);               // 投狼率来自 good.toulang_pct
  assert.match(html, /infohint/);          // 数据说明 ⓘ 提示
  assert.match(html, /关闭本程序再重新打开/); // 提示文案（缓存无自动刷新，关掉重开取最新）
  assert.doesNotMatch(html, /refreshPlayer/); // “刷新缓存”交互已移除
});

test('renderDetailHTML：角色或版型数据为空时显示明确空状态', () => {
  const empty = { games: [], roles: [], editions: [] };
  assert.match(renderDetailHTML(state({ detailTab: 'roles', model: empty })), /暂无角色表现/);
  assert.match(renderDetailHTML(state({ detailTab: 'editions', model: empty })), /暂无版型表现/);
});

test('详情加载提示：首次查询分阶段提示用户耐心等待', () => {
  const first = detailLoadingHTML(0, true);
  assert.match(first, /首次查询/);
  assert.match(first, /耐心等待/);
  assert.match(detailLoadingHTML(1, true), /正在正常运行/);
  assert.match(detailLoadingHTML(2, true), /自动显示结果/);
  assert.match(detailLoadingHTML(0, false), /正在处理数据/);
  assert.match(renderDetailHTML({ model: null }), /首次查询/);
});

test('renderDetailHTML：统计失败（无门派）→ 统计区错误，不影响战绩区', () => {
  const html = renderDetailHTML(state({ model: { stats_error: '统计炸了', comprehensive: [] } }));
  assert.match(html, /获取失败：统计炸了/);
  assert.match(renderDetailHTML(state({ detailTab: 'games', model: { stats_error: '统计炸了', comprehensive: [] } })), /共 1 场/);
});

test('renderDetailHTML：战绩失败 → 战绩区错误、队伍名占位；截断提示', () => {
  const errHtml = renderDetailHTML(state({ detailTab: 'games', model: { games_error: '战绩炸了', games: [] } }));
  assert.match(errHtml, /获取失败：战绩炸了/);
  const truncHtml = renderDetailHTML(state({ detailTab: 'games', model: { games_trunc: true } }));
  assert.match(truncHtml, /当前仅展示部分数据/);
});

test('renderDetailHTML：两阶段头部——gamesLoading 且首页未到 → 逐场纯占位、角色/队伍“加载中”', () => {
  const html = renderDetailHTML(state({ detailTab: 'games', gamesLoading: true, model: { games: [], roles: [], teams: [] } }));
  assert.match(html, /正在加载逐场战绩/);        // 无首页行：逐场区纯占位
  assert.doesNotMatch(html, /无战绩/);            // 不再误显示“无战绩”
  assert.match(html, /加载中…/);                  // 角色/队伍占位
  assert.match(html, /张三/);                     // 头部（来自 stats）照常渲染
  assert.match(renderDetailHTML(state({ gamesLoading: true, model: { games: [], roles: [], teams: [] } })), /🎯 综合/); // 概览已可用
});

test('renderDetailHTML：首屏预览——gamesLoading 且已有首页行 → 渲染表格但禁用筛选/排序、显示总场数', () => {
  const html = renderDetailHTML(state({ detailTab: 'games', gamesLoading: true, model: { games_total: 9999, games_total_known: true, roles: [] } }));
  assert.match(html, /openGame\(11\)/);          // 首屏行已渲染（model 默认含一行 game_id=11）
  assert.match(html, /共 9999 场/);               // 总数确定时显示“共 N 场”
  assert.match(html, /正在加载完整战绩/);
  assert.doesNotMatch(html, /setGF/);             // 筛选栏禁用（不渲染 qfbar）
  assert.doesNotMatch(html, /sortGames/);         // 排序表头禁用
  assert.doesNotMatch(html, /正在加载逐场战绩/);   // 有首页行时不再显示纯占位
  const roles = renderDetailHTML(state({ detailTab: 'roles', gamesLoading: true, model: { games_total: 9999, games_total_known: true, roles: [] } }));
  assert.match(roles, /🎭 角色表现/);
  assert.match(roles, /加载中…/);
});

test('renderDetailHTML：首屏预览总数未知时只说明已显示数量', () => {
  const html = renderDetailHTML(state({ detailTab: 'games', gamesLoading: true, model: { games_total: 1, games_total_known: false, roles: [] } }));
  assert.match(html, /已显示 1 场/);
  assert.match(html, /正在加载完整战绩/);
  assert.doesNotMatch(html, /共 1 场/);   // 未知时不写“共 N 场”
  assert.doesNotMatch(html, /共 -1 场/);
});

test('renderDetailHTML：gamesLoading=false（逐场已到）→ 正常渲染表格，无加载占位', () => {
  const html = renderDetailHTML(state({ detailTab: 'games', gamesLoading: false }));
  assert.match(html, /openGame\(11\)/);
  assert.doesNotMatch(html, /正在加载逐场战绩/);
});

test('renderDetailHTML：逐场出错优先于 gamesLoading（不显示加载占位）', () => {
  const html = renderDetailHTML(state({ detailTab: 'games', gamesLoading: true, model: { games_error: '炸了', games: [] } }));
  assert.match(html, /获取失败：炸了/);
  assert.doesNotMatch(html, /正在加载逐场战绩/);
});

test('renderDetailHTML：客户端快捷筛选——只看胜场时按 result 过滤逐场（不发请求）', () => {
  const two = {
    games: [
      { game_id: 11, play_date: '2024-01-02', rpt_name: '平民', total_point: 5, win: 1 },
      { game_id: 12, play_date: '2024-01-01', rpt_name: '狼', total_point: 3, win: 0 },
    ],
  };
  assert.match(renderDetailHTML(state({ detailTab: 'games', model: two })), /共 2 场/);
  assert.match(renderDetailHTML(state({ detailTab: 'games', model: two, gf: { result: 'w' } })), /共 1 场/);   // 只剩胜场
  assert.match(renderDetailHTML(state({ detailTab: 'games', model: two, gf: { camp: 'wolf' } })), /共 1 场/);  // isGoodCamp 客户端分阵营
});

test('renderGameHTML：按人视图—座位表、胜负、我方高亮、技能动作、页签', () => {
  const g = {
    play_date: '2024-01-01', round: 2, season_id: 6, victory_camp: 1, mvp_seat: 3, svp_seat: 5, referee_name: '李四', day: 1,
    form2: { rows: [
      { seat: 1, player_id: 7, player_name: '张三', sect_name: '门派A', rpt_name: '狼', vote_day1: '2', skills: [] },
      { seat: 2, player_id: 8, player_name: '王五', rpt_name: '预言家', skills: [{ day: 1, name: '预言家', target_seats: [3] }] },
    ] },
  };
  const html = renderGameHTML(g, 7);
  assert.match(html, /好人胜/);
  assert.match(html, /张三/); assert.match(html, /王五/);
  assert.match(html, /class="me"/);
  assert.match(html, /D1 验→3/);
  assert.match(html, /setGameMode\('day'\)/);
  assert.match(html, /按人/); assert.match(html, /按天/);
  assert.match(html, /seat-wide/); assert.match(html, /seat-narrow/);
});

test('renderGameHTML：按天视图—顺序 技能→警徽→投票，顶盾、警徽投票', () => {
  const g = {
    play_date: '2024-01-01', day: 2, victory_camp: 2,
    form2: { rows: [
      { seat: 1, player_id: 7, player_name: '张三', rpt_name: '预言家', vote_jinhui: '3', vote_day1: '2', vote_day2: '0', day_of_jinhui: 1, skills: [{ day: 1, name: '预言家', target_seats: [4] }] },
      { seat: 5, player_id: 8, player_name: '李四', rpt_name: '怪盗狼王', vote_day1: '1', skills: [{ day: 2, name: '怪盗', target_seats: [5] }] },
    ] },
  };
  const html = renderGameHTML(g, 7, 'day');
  assert.match(html, /警徽竞选/);
  assert.match(html, /第 1 天/); assert.match(html, /第 2 天/);
  assert.match(html, /1号张三/);           // 技能行动方：座号+名
  assert.match(html, /验/); assert.match(html, /4号/);   // 目标（座4不在场→只显示“4号”）
  assert.match(html, /李四/); assert.match(html, /顶盾/); // 怪盗狼王对自己=顶盾
  assert.match(html, /当选/);              // day_of_jinhui=1 → 警徽当选
  // 顺序：技能块在警徽块之前，警徽块在投票块之前
  assert.ok(html.indexOf('技能') < html.indexOf('警徽竞选'));
  assert.ok(html.indexOf('警徽竞选') < html.indexOf('投票'));
  assert.doesNotMatch(html, /<table class="gt"/);
});

test('renderGameHTML：按天—狼刀合并成一条 + 目标带角色（不再列狼队成员）', () => {
  const g = {
    play_date: 'x', day: 1, victory_camp: 2,
    form2: { rows: [
      { seat: 1, player_id: 1, player_name: '张三', rpt_name: '狼', skills: [{ day: 1, name: '狼刀', target_seats: [3] }] },
      { seat: 4, player_id: 4, player_name: '赵六', rpt_name: '狼王', skills: [{ day: 1, name: '狼刀', target_seats: [3] }] },
      { seat: 3, player_id: 3, player_name: '李四', rpt_name: '平民', skills: [] },
    ] },
  };
  const html = renderGameHTML(g, 9, 'day');
  assert.match(html, /狼刀/);
  assert.match(html, /3号 李四/);          // 目标解析出座位+名
  assert.equal((html.match(/狼刀/g) || []).length, 1);   // 两个狼合并为一条
  assert.doesNotMatch(html, /狼队/);       // 无 analysis 花名册时不再显示狼队成员
  assert.doesNotMatch(html, /1号张三/);    // 发动的狼队成员不再列出
});

test('dayVotes：按天投票按被投目标归并，每目标一行、弃票置末，号码带名字身份', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map(n => ({ seat: n, player_id: n, player_name: 'P' + n, rpt_name: n === 2 ? '狼' : '平民', skills: [] }));
  const g = {
    play_date: 'x', day: 1, victory_camp: 2, form2: { rows },
    analysis: { votes: { '1': [
      { seat: 1, target: 2 }, { seat: 2, target: 3 }, { seat: 3, target: 2 },
      { seat: 4, target: 3 }, { seat: 5, target: 4 }, { seat: 6, abstain: true }, { seat: 7, abstain: true },
    ] } },
  };
  const html = renderGameHTML(g, 0, 'day');
  const vrows = [...html.matchAll(/<div class="vote-row">([\s\S]*?)<\/div>/g)].map(m => m[1]);
  assert.equal(vrows.length, 4);                       // 目标 2 / 3 / 4 + 弃票 共 4 行
  const row2 = vrows.find(r => /→[\s\S]*2号/.test(r));
  assert.ok(row2 && /1号/.test(row2) && /3号/.test(row2));   // 1,3 → 2
  assert.match(row2, /P2·狼/);                          // 被投号码带名字·身份
  assert.match(vrows[vrows.length - 1], /弃票/);         // 弃票行置末
  assert.ok(/6号/.test(vrows[3]) && /7号/.test(vrows[3])); // 6,7 → 弃票
});

test('renderGameHTML：analysis—花名册/出局时间线/放逐制表/投票着色/背锅/扣分/出局标记', () => {
  const g = {
    play_date: 'x', day: 2, victory_camp: 2, mvp_seat: 2, svp_seat: 3, referee_name: '王',
    form2: {
      rows: [
        { seat: 1, player_id: 7, player_name: '张三', rpt_name: '狼', skills: [] },
        { seat: 2, player_id: 8, player_name: '李四', rpt_name: '预言家', skills: [] },
        { seat: 3, player_id: 9, player_name: '王五', rpt_name: '平民', skills: [] },
      ],
      points: [{ day: 1, name: '发言违规', seat: 3, point: -1 }],
    },
    analysis: {
      roster: { wolf: [1], gods: [2], civ: [3], special_role: '', special_seat: 0 },
      badge: { '1': 2 },
      votes: { '1': [{ seat: 2, target: 1, weight: 1.5, abstain: false, badge: true }, { seat: 3, target: 2, weight: 1, abstain: false, badge: false }] },
      exile: { '1': { seat: 1, peaceful: false, tally: [{ seat: 1, votes: 1.5 }, { seat: 2, votes: 1 }] } },
      deaths: [{ seat: 1, day: 1, phase: 'day', cause: 'exile', doubt: false }, { seat: 2, day: 2, phase: 'night', cause: 'knife', doubt: false }],
      alive_final: [3],
    },
  };
  const meRow = { game_id: 1, seat: 2, bgx: 1 };
  const day = renderGameHTML(g, 8, 'day', meRow);
  assert.match(day, /狼队/);                       // 花名册
  assert.match(day, /出局顺序/);                    // 时间线
  assert.match(day, /放逐/); assert.match(day, /狼刀/);  // 中文死因
  assert.match(day, /vhit/); assert.match(day, /vmiss/); // 投狼绿/投好人红
  assert.match(day, /★/);                          // 警长 1.5 票
  assert.match(day, /违规扣分/); assert.match(day, /发言违规/);
  assert.match(day, /背锅/);                        // meRow.bgx → 背锅当前选手
  assert.match(day, /MVP 2号/); assert.match(day, /尽力 3号/);
  const seat = renderGameHTML(g, 8, 'seat', meRow);
  assert.match(seat, /out-tag/); assert.match(seat, /出局·第1天/);   // 座位视图出局标记
});

// —— api.js（薄壳）：只与本地 /api/* 交互，无令牌、无官方地址；401 弹横幅（刷新由 Go 侧完成）——
function installDom() {
  const els = {};
  globalThis.document = { querySelector: sel => els[sel] || (els[sel] = { innerHTML: '', textContent: '', dataset: {} }) };
  return els;
}
const resp = ({ ok = true, status = 200, body = '' }) => ({ ok, status, text: async () => body, json: async () => JSON.parse(body) });

test('searchPlayers / detail / game：拼本地端点 URL 并返回解析后的 JSON', async () => {
  let seen;
  globalThis.fetch = async url => { seen = url; return resp({ body: JSON.stringify({ ok: 1 }) }); };
  await searchPlayers('张三');
  assert.match(seen, /^\/api\/players\/search\?name=/);
  await detail('id=7&zone=ALL&season=6');
  assert.equal(seen, '/api/players/detail?id=7&zone=ALL&season=6');
  await game(43330);
  assert.equal(seen, '/api/games?id=43330');
});

test('赛事 API：目录、排名、按需指标和门派成员只走本地端点', async () => {
  const seen = [];
  globalThis.fetch = async url => { seen.push(url); return resp({ body: '{}' }); };
  await eventCatalog();
  await eventSeasons('SD');
  await eventAvailability('29', 'SD');
  await eventRankings('29', '4', 'SD');
  await eventRankAggregate('29', '4', 'SD');
  await eventTeam(13, '29', '4', 'SD');
  assert.equal(seen[0], '/api/events/catalog');
  assert.equal(seen[1], '/api/events/seasons?zone=SD');
  assert.equal(seen[2], '/api/events/availability?season=29&zone=SD');
  assert.match(seen[3], /^\/api\/events\/rankings\?/);
  assert.match(seen[3], /season=29/);
  assert.match(seen[3], /type=4/);
  assert.match(seen[3], /zone=SD/);
  assert.match(seen[4], /^\/api\/events\/metrics\?/);
  assert.match(seen[4], /season=29/);
  assert.match(seen[5], /^\/api\/events\/team\?/);
  assert.match(seen[5], /id=13/);
  assert.match(seen[5], /season=29/);
  assert.match(seen[5], /type=4/);
  assert.match(seen[5], /zone=SD/);
  assert.doesNotMatch(seen[5], /page=|size=/);
});

test('赛事数据展示：筛选、排名分页和作用域成员名单完整呈现', () => {
  const catalog = {
    seasons: [{ value: '29', label: 'S29' }],
    season_types: [{ value: '4', label: '季后赛' }],
    zones: [{ value: 'SD', label: '山东赛区' }],
    editions: [{ value: '18', label: '侦探怪盗守卫' }],
    roles: [{ value: '2', label: '狼', camp: 2 }],
  };
  const html = renderEventsHTML({ catalog, season: '29', type: '4', zone: 'SD', metricsReady: true, showMetrics: true, rankings: { metric_mode: 'game', metrics_available: true, items: [{ rank: 1, sect_id: 13, sect_name: '鱼乐会', total_point: 99.5, games: 5, avg: 19.9, mvp: 2, svp: 1, bgx: 0 }] } });
  assert.match(html, /山东赛区 · S29 · 季后赛/);
  assert.match(html, /鱼乐会/);
  assert.match(html, /点击门派查看出场成员/);
  assert.match(html, /setEventRankSort\('total_point'\)/);
  assert.match(html, /setEventRankSort\('games'\)/);
  assert.match(html, /setEventRankSort\('avg'\)/);
  assert.match(html, /setEventRankSort\('mvp'\)/);
  assert.match(html, /setEventRankSort\('svp'\)/);
  assert.match(html, /setEventRankSort\('bgx'\)/);
  assert.match(html, /收起场次与场均分/);
  assert.match(html, /场次/);
  assert.match(html, /场均分/);
  assert.doesNotMatch(html, /局数|局均分/);
  assert.match(html, /19\.9/);
  assert.doesNotMatch(html, /event-reference/);
  const team = renderEventTeamHTML({ id: 13, name: '鱼乐会', chief: '掌门甲', members: [{ value: 109, label: 'Will', matches: 3, total_point: 12.5, avg: 4.17, win: 67, mvp: 1, svp: 0, bgx: 0 }] }, { catalog, season: '29', type: '4', zone: 'SD', memberSort: { key: 'total_point', dir: -1 } });
  assert.match(team, /1 名出场成员/);
  assert.match(team, /Will/);
  assert.match(team, /3 场/);
  assert.match(team, /12\.5/);
  assert.match(team, /67%/);
  assert.match(team, /setEventMemberSort\('avg'\)/);
  assert.match(team, /openPlayer\(this\.dataset\.player\)/);
  assert.match(team, /山东赛区 · S29 · 季后赛/);
  assert.doesNotMatch(team, /mobile/);
  const sorted = renderEventTeamHTML({ id: 13, name: '鱼乐会', members: [
    { value: 1, label: '甲', matches: 9, total_point: 1, avg: 0.11, win: 11 },
    { value: 2, label: '乙', matches: 2, total_point: 20, avg: 10, win: 100 },
  ] }, { catalog, season: '29', type: '4', zone: 'SD', memberSort: { key: 'total_point', dir: -1 } });
  assert.ok(sorted.indexOf('乙') < sorted.indexOf('甲'), '成员应按所选统计列排序');
  assert.doesNotMatch(sorted, /setEventTeamPage|第 1 \/ 3 页/);
});

test('赛事排名：总分、天数和均分排序后重新计算当前名次', () => {
  const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [], zones: [{ value: 'SD', label: '山东赛区' }] };
  const rankings = { metrics_available: true, items: [
    { rank: 1, sect_id: 1, sect_name: '总分队', total_point: 100, days: 2, avg: 50 },
    { rank: 2, sect_id: 2, sect_name: '天数队', total_point: 80, days: 9, avg: 8.89 },
  ] };
  const html = renderEventsHTML({ catalog, season: '29', type: '3', zone: 'SD', metricsReady: true, showMetrics: true, rankings: { ...rankings, metric_mode: 'day' }, rankSort: { key: 'days', dir: -1 } });
  assert.ok(html.indexOf('天数队') < html.indexOf('总分队'));
  assert.match(html, /event-rank">1<\/td><td><b>天数队/);
  assert.match(html, /日均分/);
});

test('赛事排名：MVP、尽力和背锅支持排序', () => {
  const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [], zones: [{ value: 'SD', label: '山东赛区' }] };
  const items = [
    { sect_id: 1, sect_name: '甲队', total_point: 10, games: 3, avg: 3.33, mvp: 1, svp: 5, bgx: 0 },
    { sect_id: 2, sect_name: '乙队', total_point: 9, games: 3, avg: 3, mvp: 4, svp: 0, bgx: 3 },
  ];
  const render = key => renderEventsHTML({ catalog, availableSeasons: catalog.seasons, season: '29', type: '4', zone: 'SD', rankings: { metric_mode: 'game', items }, rankSort: { key, dir: -1 } });
  assert.ok(render('mvp').indexOf('乙队') < render('mvp').indexOf('甲队'));
  assert.ok(render('svp').indexOf('甲队') < render('svp').indexOf('乙队'));
  assert.ok(render('bgx').indexOf('乙队') < render('bgx').indexOf('甲队'));
});

test('赛事排名：有效天数下的零均分显示为 0', () => {
  const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [], zones: [{ value: 'SD', label: '山东赛区' }] };
  const html = renderEventsHTML({ catalog, season: '29', type: '3', zone: 'SD', metricsReady: true, showMetrics: true, rankings: { metric_mode: 'day', metrics_available: true, items: [{ sect_id: 1, sect_name: '零分队', total_point: 0, days: 1 }] } });
  assert.match(html, /<td>1<\/td><td>0<\/td>/);
});

test('赛事排名：天数与日均分默认收起，按钮在计算完成前不可点', () => {
  const catalog = { seasons: [{ value: '30', label: 'S30' }], season_types: [{ value: '2', label: '踢馆赛' }], zones: [{ value: 'SH', label: '上海赛区' }] };
  const base = { catalog, season: '30', type: '2', zone: 'SH', rankings: { metric_mode: 'day', metrics_available: true, items: [{ sect_id: 78, sect_name: '青城', total_point: 69, days: 5, avg: 13.8 }] } };
  // 计算中：按钮禁用 + 面向用户提示，不显示天数/日均分两列，也不出现开发者式“加载中…”。
  const loading = renderEventsHTML({ ...base, metricsLoading: true });
  assert.match(loading, /正在为你计算天数与日均分/);
  assert.match(loading, /查看天数与日均分<\/button>/);
  assert.match(loading, /<button class="ghost" disabled>/);
  assert.doesNotMatch(loading, /加载中…/);
  assert.doesNotMatch(loading, /13\.8/);
  // 算好但用户未点开：仍不显示两列，按钮可点。
  const ready = renderEventsHTML({ ...base, metricsReady: true });
  assert.match(ready, /查看天数与日均分/);
  assert.match(ready, /toggleEventMetrics\(\)/);
  assert.doesNotMatch(ready, /13\.8/);
  // 点开后：两列出现，按钮变“收起”。
  const shown = renderEventsHTML({ ...base, metricsReady: true, showMetrics: true });
  assert.match(shown, /收起天数与日均分/);
  assert.match(shown, /13\.8/);
});

test('赛事筛选：只显示该赛区和赛季实际可用的赛季及比赛类型', () => {
  const catalog = {
    seasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }],
    season_types: [{ value: '3', label: '常规赛' }, { value: '4', label: '季后赛' }],
    zones: [{ value: 'SH', label: '上海赛区' }, { value: 'SD', label: '山东赛区' }],
  };
  const html = renderEventsHTML({ catalog, availableSeasons: [{ value: '29', label: 'S29' }], availableTypes: [{ value: '4', label: '季后赛' }], season: '29', type: '4', zone: 'SD' });
  assert.doesNotMatch(html, /正在根据真实赛事数据更新可选范围/);
  assert.doesNotMatch(html, /全部赛区/);
  assert.match(html, /S29/);
  assert.doesNotMatch(html, />S30</);
  assert.doesNotMatch(html, />常规赛</);
  assert.match(html, />季后赛</);
});

test('赛事筛选：修改条件只更新本地状态，不自动查询或计算', () => {
  const previousDocument = globalThis.document;
  const elements = {
    '#event-season': { value: '29' }, '#event-type': { value: '4' }, '#event-zone': { value: 'SD' },
    '#events-body': { innerHTML: '' },
  };
  globalThis.document = { querySelector: selector => elements[selector] || null };
  let calls = 0;
  globalThis.fetch = async () => { calls++; return resp({ body: '{}' }); };
  __setEventsState({
    catalog: { seasons: [{ value: '29', label: 'S29' }], season_types: [{ value: '4', label: '季后赛' }], zones: [{ value: 'SD', label: '山东赛区' }] },
    rankings: { items: [{ sect_id: 1 }] }, abort: null,
  });
  syncEventFilters();
  assert.equal(calls, 0);
  assert.match(elements['#events-body'].innerHTML, /选择赛事范围后查看门派排名/);
  globalThis.document = previousDocument;
});

test('赛事排名：全部比赛类型只显示总分，不计算天数/均分并提示选择具体类型', async () => {
  const previousDocument = globalThis.document;
  const elements = { '#event-season': { value: '29' }, '#event-type': { value: '' }, '#event-zone': { value: 'SH' }, '#events-body': { innerHTML: '' } };
  globalThis.document = { querySelector: s => elements[s] || null };
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(url);
    if (url.startsWith('/api/events/rankings')) return resp({ body: JSON.stringify({ metric_mode: 'game', items: [{ sect_id: 1, sect_name: '甲队', total_point: 10 }] }) });
    throw new Error('unexpected URL: ' + url);
  };
  try {
    __setEventsState({ catalog: { seasons: [{ value: '29', label: 'S29' }], season_types: [], zones: [{ value: 'SH', label: '上海赛区' }] }, season: '29', type: '', zone: 'SH', seasonsLoading: false, typesLoading: false, rankings: null, abort: null, gen: 0 });
    await queryEvents();
    assert.ok(seen.some(u => u.startsWith('/api/events/rankings')), '应查询门派排名');
    assert.ok(!seen.some(u => u.startsWith('/api/events/metrics')), '全部比赛类型不应请求派生指标');
    assert.match(elements['#events-body'].innerHTML, /选择具体比赛类型后可查看/);
    assert.doesNotMatch(elements['#events-body'].innerHTML, /正在为你计算/);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('赛事筛选：切换赛区依次刷新可用赛季和比赛类型，不自动读取排名或均分', async () => {
  const previousDocument = globalThis.document;
  const elements = {
    '#event-season': { value: '30' }, '#event-type': { value: '2' }, '#event-zone': { value: 'BJ' },
    '#events-body': { innerHTML: '' },
  };
  globalThis.document = { querySelector: selector => elements[selector] || null };
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(url);
    if (url === '/api/events/seasons?zone=BJ') return resp({ body: JSON.stringify({ zone: 'BJ', seasons: [{ value: '29', label: 'S29' }] }) });
    if (url === '/api/events/season-types?season=29&zone=BJ') return resp({ body: JSON.stringify({ season_types: [{ value: '4', label: '季后赛' }] }) });
    throw new Error('unexpected URL: ' + url);
  };
  __setEventsState({
    catalog: { seasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }], season_types: [{ value: '2', label: '踢馆赛' }], zones: [{ value: 'SH', label: '上海赛区' }, { value: 'BJ', label: '北京赛区' }] },
    availableSeasons: [{ value: '30', label: 'S30' }], rankings: { items: [{ sect_id: 1 }] }, abort: null,
    zone: 'SH', season: '30', type: '2', seasonGen: 0, seasonsLoading: false, seasonsError: '',
    availableTypes: [{ value: '2', label: '踢馆赛' }], typeGen: 0, typesLoading: false, typesError: '',
  });
  await syncEventFilters('zone');
  assert.deepEqual(seen, ['/api/events/seasons?zone=BJ', '/api/events/season-types?season=29&zone=BJ']);
  assert.match(elements['#events-body'].innerHTML, />S29</);
  assert.doesNotMatch(elements['#events-body'].innerHTML, />S30</);
  assert.match(elements['#events-body'].innerHTML, />季后赛</);
  assert.doesNotMatch(elements['#events-body'].innerHTML, />踢馆赛</);
  globalThis.document = previousDocument;
});

test('赛事筛选：切换赛季会刷新当前赛区的比赛类型', async () => {
  const previousDocument = globalThis.document;
  const elements = {
    '#event-season': { value: '29' }, '#event-type': { value: '2' }, '#event-zone': { value: 'BJ' },
    '#events-body': { innerHTML: '' },
  };
  globalThis.document = { querySelector: selector => elements[selector] || null };
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(url);
    return resp({ body: JSON.stringify({ season_types: [{ value: '3', label: '常规赛' }] }) });
  };
  __setEventsState({
    catalog: { seasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }], season_types: [{ value: '2', label: '踢馆赛' }, { value: '3', label: '常规赛' }], zones: [{ value: 'BJ', label: '北京赛区' }] },
    availableSeasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }],
    availableTypes: [{ value: '2', label: '踢馆赛' }], zone: 'BJ', season: '30', type: '2', rankings: { items: [{ sect_id: 1 }] },
    typeGen: 0, typesLoading: false, typesError: '', abort: null,
  });
  await syncEventFilters('season');
  assert.deepEqual(seen, ['/api/events/season-types?season=29&zone=BJ']);
  assert.match(elements['#events-body'].innerHTML, />常规赛</);
  assert.doesNotMatch(elements['#events-body'].innerHTML, />踢馆赛</);
  assert.match(elements['#events-body'].innerHTML, /选择赛事范围后查看门派排名/);
  globalThis.document = previousDocument;
});

test('赛事筛选：迟到的比赛类型请求不会覆盖后来选择的赛季', async () => {
  const previousDocument = globalThis.document;
  const elements = {
    '#event-season': { value: '29' }, '#event-type': { value: '4' }, '#event-zone': { value: 'SD' },
    '#events-body': { innerHTML: '' },
  };
  globalThis.document = { querySelector: selector => elements[selector] || null };
  let resolveFirst;
  globalThis.fetch = async url => {
    if (url.includes('season=29')) return new Promise(resolve => { resolveFirst = resolve; });
    if (url.includes('season=30')) return resp({ body: JSON.stringify({ season_types: [{ value: '2', label: '踢馆赛' }] }) });
    throw new Error('unexpected URL: ' + url);
  };
  __setEventsState({
    catalog: { seasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }], season_types: [{ value: '2', label: '踢馆赛' }, { value: '4', label: '季后赛' }], zones: [{ value: 'SD', label: '山东赛区' }] },
    availableSeasons: [{ value: '30', label: 'S30' }, { value: '29', label: 'S29' }], availableTypes: null,
    zone: 'SD', season: '29', type: '4', typeGen: 0, typesLoading: false, typesError: '', abort: null,
  });
  const first = syncEventFilters('season');
  elements['#event-season'].value = '30';
  elements['#event-type'].value = '2';
  const second = syncEventFilters('season');
  await second;
  resolveFirst(resp({ body: JSON.stringify({ season_types: [{ value: '4', label: '季后赛' }] }) }));
  await first;
  assert.match(elements['#events-body'].innerHTML, />踢馆赛</);
  assert.doesNotMatch(elements['#events-body'].innerHTML, />季后赛</);
  globalThis.document = previousDocument;
});

test('赛事筛选：读取比赛类型期间禁用选择框和查询', () => {
  const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [{ value: '4', label: '季后赛' }], zones: [{ value: 'SD', label: '山东赛区' }] };
  const html = renderEventsHTML({ catalog, availableSeasons: catalog.seasons, availableTypes: null, season: '29', type: '4', zone: 'SD', typesLoading: true });
  assert.match(html, /id="event-type"[^>]* disabled/);
  assert.match(html, /onclick="queryEvents\(\)" disabled/);
  assert.match(html, /正在读取当前赛区和赛季的可用比赛类型/);
});

test('赛事导航：离开赛事页会取消排名和指标请求', () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const pages = {
    '#home': { hidden: true }, '#personal-page': { hidden: true }, '#events-page': { hidden: false }, '#tools-page': { hidden: true }, '#q': { focus() {} },
  };
  try {
    globalThis.document = { querySelector: selector => pages[selector] || null };
    globalThis.window = { scrollTo() {} };
    const homeRequest = new AbortController();
    __setEventsState({ abort: homeRequest, loading: true, metricsLoading: true, gen: 10 });
    showHome();
    assert.equal(homeRequest.signal.aborted, true);
    assert.equal(pages['#home'].hidden, false);

    const personalRequest = new AbortController();
    pages['#events-page'].hidden = false;
    __setEventsState({ abort: personalRequest, loading: true, metricsLoading: true });
    showPersonal();
    assert.equal(personalRequest.signal.aborted, true);
    assert.equal(pages['#personal-page'].hidden, false);

    showTools();
    assert.equal(pages['#tools-page'].hidden, false);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('赛事门派：迟到的旧请求不会覆盖后来打开的门派', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const body = { innerHTML: '' };
  try {
    globalThis.document = { querySelector: selector => selector === '#events-body' ? body : null };
    globalThis.window = { innerWidth: 1200, innerHeight: 900, scrollTo() {} };
    let resolveFirst, firstSignal;
    globalThis.fetch = async (url, options = {}) => {
      if (url.includes('id=91001')) {
        firstSignal = options.signal;
        return new Promise(resolve => { resolveFirst = resolve; });
      }
      if (url.includes('id=91002')) return resp({ body: JSON.stringify({ id: 91002, name: '后打开门派', members: [] }) });
      throw new Error('unexpected URL: ' + url);
    };
    __setEventsState({
      catalog: { seasons: [{ value: '29', label: 'S29' }], season_types: [{ value: '4', label: '季后赛' }], zones: [{ value: 'SD', label: '山东赛区' }] },
      season: '29', type: '4', zone: 'SD', screen: 'rankings', team: null, teamGen: 0, teamAbort: null, teamRequestKey: '',
    });
    const first = showEventTeam(91001);
    closeEventTeam();
    assert.equal(firstSignal.aborted, true, '返回排名时应立即取消旧门派请求');
    const second = showEventTeam(91002);
    await second;
    resolveFirst(resp({ body: JSON.stringify({ id: 91001, name: '迟到旧门派', members: [] }) }));
    await first;
    assert.match(body.innerHTML, /后打开门派/);
    assert.doesNotMatch(body.innerHTML, /迟到旧门派/);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('赛事排名：每页最多 15 支且不使用内部滚动容器', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, sect_id: i + 1, sect_name: '门派' + (i + 1), total_point: 20 - i }));
  const html = renderEventsHTML({ catalog: { seasons: [{ value: '29', label: 'S29' }], season_types: [], zones: [{ value: 'SH', label: '上海赛区' }] }, availableSeasons: [{ value: '29', label: 'S29' }], season: '29', type: '', zone: 'SH', page: 1, metricsReady: true, showMetrics: true, rankings: { metric_mode: 'game', metrics_available: true, items } });
  assert.match(html, /第 1 \/ 2 页/);
  assert.match(html, /门派15/);
  assert.doesNotMatch(html, /门派16/);
  assert.match(styles, /\.event-rank-table table\{table-layout:fixed/);
  assert.doesNotMatch(styles, /\.event-rank-table\{[^}]*overflow/);
  assert.match(styles, /nth-child\(n\+6\)/);
  assert.match(html, /setEventRankSort\('games'\)/);
  assert.match(html, /setEventRankSort\('avg'\)/);
});

test('赛事排名：展开全部按钮切换到不分页显示所有门派', () => {
  const catalog = { seasons: [{ value: '29', label: 'S29' }], season_types: [], zones: [{ value: 'SH', label: '上海赛区' }] };
  const items = Array.from({ length: 20 }, (_, i) => ({ rank: i + 1, sect_id: i + 1, sect_name: '门派' + (i + 1), total_point: 20 - i }));
  const base = { catalog, availableSeasons: [{ value: '29', label: 'S29' }], season: '29', type: '', zone: 'SH', page: 1, rankings: { metric_mode: 'game', items } };
  // 默认分页：只见首页，且提供“展开全部”入口。
  const paged = renderEventsHTML(base);
  assert.match(paged, /第 1 \/ 2 页/);
  assert.match(paged, /toggleEventExpand\(\)/);
  assert.match(paged, /展开全部/);
  assert.doesNotMatch(paged, /门派16/);
  // 展开后：所有门派一次显示，分页翻页消失，改为“收起分页”。
  const expanded = renderEventsHTML({ ...base, expandAll: true });
  assert.match(expanded, /门派16/);
  assert.match(expanded, /门派20/);
  assert.match(expanded, /已显示全部 20 支门派/);
  assert.match(expanded, /收起分页/);
  assert.doesNotMatch(expanded, /第 1 \/ 2 页/);
});

test('api 层：非 2xx 或含 error 字段 → 抛出带 message 与 status 的错误', async () => {
  globalThis.fetch = async () => resp({ ok: false, status: 500, body: JSON.stringify({ error: { message: 'boom' } }) });
  await assert.rejects(() => game(1), e => e.message === 'boom' && e.status === 500);
});

test('主动取消本地请求：保留 AbortError，不误报服务失联', async () => {
  let alerts = 0;
  globalThis.window = { alert: () => { alerts++; }, close: () => {} };
  const aborted = new Error('aborted'); aborted.name = 'AbortError';
  globalThis.fetch = async () => { throw aborted; };
  await assert.rejects(() => game(1), e => e === aborted);
  assert.equal(alerts, 0);
  delete globalThis.window;
});

test('本地服务失联：包装错误、提示重启并尝试关闭页面', async () => {
  let message = '', closes = 0;
  globalThis.window = { alert: s => { message = s; }, close: () => { closes++; } };
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(() => game(1), e => e.name === 'LocalServerError' && e.status === 0 && /重新启动/.test(e.message));
  assert.match(message, /连接已断开/);
  assert.match(message, /手动关闭/);
  assert.equal(closes, 1);
  await assert.rejects(() => game(2), e => e.name === 'LocalServerError');
  await assert.rejects(() => refreshSession(), e => e.name === 'LocalServerError');
  assert.equal(closes, 1, '并发或后续失败不应重复弹窗、重复关闭');
  delete globalThis.window;
});

test('api 层：401 → 触发 onAuthLost 回调并抛错（回调改为“回到引导页”，不再用内联横幅）', async () => {
  let lost = 0;
  setAuthLostHandler(() => lost++);
  globalThis.fetch = async () => resp({ ok: false, status: 401, body: '' });
  await assert.rejects(() => detail('id=1'), e => e.status === 401);
  assert.equal(lost, 1);
  setAuthLostHandler(null);
});

test('gateHTML：无令牌引导——获取步骤 + 重新检测按钮（纯函数）；按原因换标题', () => {
  const h = gateHTML();
  assert.match(h, /还没检测到你的登录令牌/);
  assert.match(h, /电脑版微信/);
  assert.match(h, /华山战力页/);
  assert.match(h, /retryToken\(this\)/);
  assert.match(h, /我已登录，重新检测/);
  assert.match(h, /id="manual-token"/);
  assert.match(h, /useManualToken\(this\.nextElementSibling\)/);
  assert.match(h, /不会保存你输入的 Token/);
  assert.match(gateHTML('expired'), /已过期/);       // 精确原因：过期
  assert.match(gateHTML('network'), /连不上华山服务器/); // 精确原因：网络
  assert.match(gateHTML('server'), /服务器暂时异常/);   // 精确原因：服务器
});

test('gateHTML：macOS 仅显示手动 Token 引导，不提供无效的自动检测', () => {
  const html = gateHTML('no_token', true);
  assert.match(html, /macOS 版不读取微信本地数据/);
  assert.match(html, /验证并登录/);
  assert.doesNotMatch(html, /我已登录，重新检测|电脑版微信/);
});

test('手动输入框只在登录失败提示页出现；登录成功后进入首页', () => {
  const previousDocument = globalThis.document;
  const elements = {
    '#gate': { innerHTML: '', hidden: true },
    '#app': { hidden: false },
    '#home': { hidden: true },
    '#personal-page': { hidden: false },
    '#events-page': { hidden: false },
    '#tools-page': { hidden: false },
    '#tokexp': { textContent: '' },
  };
  globalThis.document = { querySelector: sel => elements[sel] || null };
  showGate();
  assert.equal(elements['#gate'].hidden, false);
  assert.match(elements['#gate'].innerHTML, /id="manual-token"/);
  assert.equal(elements['#app'].hidden, true);
  enterApp();
  assert.equal(elements['#gate'].hidden, true);
  assert.equal(elements['#app'].hidden, false);
  assert.equal(elements['#home'].hidden, false);
  assert.equal(elements['#personal-page'].hidden, true);
  assert.equal(elements['#events-page'].hidden, true);
  assert.equal(elements['#tools-page'].hidden, true);
  globalThis.document = previousDocument;
});

test('手动 Token：PUT JSON 到本地端点并更新会话；复制时才 GET 明文', async () => {
  const seen = [];
  globalThis.fetch = async (url, opt = {}) => {
    seen.push({ url, opt });
    if (opt.method === 'PUT') return resp({ body: JSON.stringify({ nick: '共享账号', exp: 1893456000, reason: '' }) });
    return resp({ body: JSON.stringify({ token: 'ey.test.token' }) });
  };
  const session = await setManualToken('ey.test.token');
  assert.equal(session.nick, '共享账号');
  assert.equal(tokenValid(), true);
  assert.equal(await currentToken(), 'ey.test.token');
  assert.equal(seen[0].url, '/api/token');
  assert.equal(seen[0].opt.method, 'PUT');
  assert.equal(seen[0].opt.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[0].opt.body), { token: 'ey.test.token' });
  assert.equal(seen[1].opt.method, 'GET');
});

test('使用说明：登录后把复制 Token 收进折叠的二级区域', async () => {
  const previousDocument = globalThis.document;
  const about = { style: {}, innerHTML: '' };
  globalThis.document = { querySelector: selector => selector === '#about' ? about : null };
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: '已登录', exp: 1893456000, reason: '' }) });
  await setManualToken('ey.test.token');
  showAbout();
  assert.equal(about.style.display, 'flex');
  assert.match(about.innerHTML, /<details class="about-submenu">[\s\S]*登录与 Token[\s\S]*复制当前 Token[\s\S]*<\/details>/);
  globalThis.document = previousDocument;
});

test('startHeartbeat：立即敲一次 /api/heartbeat（POST），stopHeartbeat 停止', () => {
  const seen = [];
  globalThis.fetch = async (url, opt) => { seen.push({ url, method: opt && opt.method }); return resp({ body: '' }); };
  startHeartbeat();
  stopHeartbeat();
  assert.deepEqual(seen[0], { url: '/api/heartbeat', method: 'POST' });
});

test('stopHeartbeat：唤醒监听器随之移除（不泄漏、可安全重启）', () => {
  const add = {}, remove = {};
  const mk = () => ({
    visibilityState: 'visible',
    addEventListener: ev => { add[ev] = (add[ev] || 0) + 1; },
    removeEventListener: ev => { remove[ev] = (remove[ev] || 0) + 1; },
  });
  globalThis.document = mk();
  globalThis.window = mk();
  globalThis.fetch = async () => resp({ body: '' });
  startHeartbeat();
  stopHeartbeat();
  for (const ev of ['visibilitychange', 'focus', 'pageshow']) {
    assert.equal(add[ev], 1, ev + ' 应注册一次');
    assert.equal(remove[ev], 1, ev + ' 应移除一次');
  }
  delete globalThis.document; delete globalThis.window;
});

test('quitApp：停心跳并 POST /api/quit', async () => {
  let seen;
  globalThis.fetch = async (url, opt) => { seen = { url, method: opt && opt.method }; return resp({ body: '' }); };
  await quitApp();
  assert.equal(seen.url, '/api/quit');
  assert.equal(seen.method, 'POST');
});

test('refreshSession + sessionReason：解析 /api/session 的精确原因字段', async () => {
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: '', exp: 0, reason: 'expired' }) });
  assert.equal(await refreshSession(true), false);
  assert.equal(sessionReason(), 'expired');
});

test('refreshSession：解析 nick/exp；force 时带 ?refresh=1，普通启动不带；失败返回 false', async () => {
  let seenUrl;
  globalThis.fetch = async url => { seenUrl = url; return resp({ body: JSON.stringify({ nick: '阿三', exp: 1893456000 }) }); };
  assert.equal(await refreshSession(false), true);
  assert.equal(seenUrl, '/api/session');
  await refreshSession(true);
  assert.equal(seenUrl, '/api/session?refresh=1');

  globalThis.fetch = async () => resp({ ok: false, status: 500, body: '' });
  assert.equal(await refreshSession(), false);
});

test('rankByRelevance：完全相同 > 前缀 > 包含（越靠前越优）> 其余；同档按名字更短、总分降序', () => {
  const arr = [
    { player_name: '张三丰', total_point: 10 },
    { player_name: '李四', total_point: 100 },     // 不含“张三”→ 末档
    { player_name: '小张三', total_point: 99 },     // 包含（位置靠后）
    { player_name: '张三', total_point: 5 },        // 完全相同
    { player_name: '张三疯子', total_point: 1 },     // 前缀，但比“张三丰”长
  ];
  const out = rankByRelevance(arr, '张三').map(p => p.player_name);
  assert.deepEqual(out, ['张三', '张三丰', '张三疯子', '小张三', '李四']);
  // 空查询：不改变原始相对顺序（稳定）
  assert.deepEqual(rankByRelevance(arr, '').map(p => p.player_name), arr.map(p => p.player_name));
});

test('prefetchPlayer：打全量 detail，在途去重、settle 后可再预热', async () => {
  const seen = [];
  globalThis.fetch = async url => { seen.push(url); return resp({ body: JSON.stringify({ player: { name: 'x' } }) }); };
  prefetchPlayer('42'); prefetchPlayer('42');   // 在途去重：只发一次
  assert.equal(seen.length, 1);
  assert.equal(seen[0], '/api/players/detail?id=42&zone=ALL');
  await new Promise(r => setTimeout(r, 0));      // 让 .finally 从在途表移除
  prefetchPlayer('42');                          // settle 后可再预热（失败/取消/LRU 淘汰后同理）
  assert.equal(seen.length, 2);
});

// —— 共享渲染原语（详情表/角色表/对比表共用，避免重复排序/格式化）——
import { kvMap, metricOf, arrowFor, sortRows } from './internal/server/web/js/format.js';
import { renderCompareHTML, inBasket, addToBasket, removeFromBasket, basketCount, __resetBasket, MAX } from './internal/server/web/js/compare.js';

test('kvMap / metricOf：KV[]→map；取值缺失显 —、百分比补 %', () => {
  assert.deepEqual(kvMap([{ key: 'a', val: 1 }, { key: 'b', val: 2 }]), { a: 1, b: 2 });
  assert.deepEqual(kvMap(null), {});
  assert.equal(metricOf({ a: 5 }, 'a'), 5);
  assert.equal(metricOf({ a: 54 }, 'a', true), '54%');
  assert.equal(metricOf({}, 'x'), '—');
  assert.equal(metricOf(null, 'x'), '—');
});

test('arrowFor：当前排序列显示 ▾/▴，其余为空', () => {
  assert.equal(arrowFor({ key: 'a', dir: -1 }, 'a'), ' ▾');
  assert.equal(arrowFor({ key: 'a', dir: 1 }, 'a'), ' ▴');
  assert.equal(arrowFor({ key: 'a', dir: -1 }, 'b'), '');
  assert.equal(arrowFor(null, 'a'), '');
});

test('sortRows：数值列缺失恒排末（不受方向影响）；字符串列空串恒末', () => {
  const rows = [{ k: 3 }, { k: null }, { k: 1 }, { k: 8 }];
  assert.deepEqual(sortRows(rows, 'k', -1).map(r => r.k), [8, 3, 1, null]);   // 降序，缺失末
  assert.deepEqual(sortRows(rows, 'k', 1).map(r => r.k), [1, 3, 8, null]);    // 升序，缺失仍末
  const srows = [{ s: 'b' }, { s: '' }, { s: 'a' }];
  assert.deepEqual(sortRows(srows, 's', 1, 'str').map(r => r.s), ['a', 'b', '']);
  const orig = [{ k: 2 }, { k: 1 }];
  sortRows(orig, 'k', 1);
  assert.deepEqual(orig.map(r => r.k), [2, 1]);   // 不改原数组
});

// —— 对比篮 reducer（DOM 用最小桩，只验证纯粹的增删/去重/封顶逻辑）——
test('对比篮：加入/去重/封顶 12/移除', () => {
  __resetBasket();
  globalThis.document = { querySelector: () => null };   // renderBasket 取不到 #basket → 早退
  const el = (id, name) => ({ dataset: { id, name, avatar: '', sect: '' }, classList: { add() {} }, disabled: false, textContent: '' });
  assert.equal(inBasket('1'), false);
  addToBasket(el('1', '张三'));
  assert.equal(inBasket('1'), true);
  assert.equal(basketCount(), 1);
  addToBasket(el('1', '张三'));                 // 重复不加
  assert.equal(basketCount(), 1);
  for (let i = 2; i <= 15; i++) addToBasket(el(String(i), 'P' + i));
  assert.equal(basketCount(), MAX);             // 封顶 12
  removeFromBasket('1');
  assert.equal(inBasket('1'), false);
  assert.equal(basketCount(), MAX - 1);
  __resetBasket();
  delete globalThis.document;
});

// —— 对比表纯渲染 ——
const cstate = (over = {}) => ({
  basket: [{ id: '1', name: '张三', avatar: '', sect: '甲' }, { id: '2', name: '李四', avatar: '', sect: '乙' }],
  rows: {
    '1': { head: { comprehensive: [{ key: 'round_total', val: 120 }, { key: 'win_pct', val: 58 }], good: [{ key: 'toulang_pct', val: 54 }] } },
    '2': { head: { comprehensive: [{ key: 'round_total', val: 98 }, { key: 'win_pct', val: 61 }], good: [{ key: 'toulang_pct', val: 49 }] } },
  },
  scope: { zone: 'ALL', season: '' }, layer: 'shallow', group: 'comprehensive', deepMode: 'matrix', metric: 'avg', role: '', sort: { key: '', dir: -1 }, hidden: [],
  ...over,
});

test('renderCompareHTML：空篮子提示', () => {
  assert.match(renderCompareHTML({ basket: [] }), /对比篮是空的/);
});

test('renderCompareHTML：顶层按阵营/按身份切换 + 综合组列标签(经 fmt)/百分比/仅显示存在的列', () => {
  const html = renderCompareHTML(cstate());
  assert.match(html, /按阵营/); assert.match(html, /按身份/);   // 顶层切换
  assert.match(html, /张三/); assert.match(html, /李四/);
  assert.match(html, /总场次/); assert.match(html, /胜率/);         // fmt 出的中文标签
  assert.match(html, /58%/);                                         // win_pct 补 %
  assert.match(html, />120</);                                       // round_total 原值
  assert.doesNotMatch(html, /MVP次数/);                              // mvp_num 无数据 → 不成列
});

test('renderCompareHTML：缺失单元格显 —', () => {
  const s = cstate();
  s.rows['2'].head.comprehensive = [{ key: 'win_pct', val: 61 }];   // 李四没有 round_total
  const html = renderCompareHTML(s);
  assert.match(html, /总场次/);        // 列仍在（张三有）
  assert.match(html, /—/);             // 李四该格为 —
});

test('renderCompareHTML：点列头排序（数值降序/升序，缺失末）', () => {
  const desc = renderCompareHTML(cstate({ sort: { key: 'round_total', dir: -1 } }));
  assert.ok(desc.indexOf('张三') < desc.indexOf('李四'));   // 120 > 98
  const asc = renderCompareHTML(cstate({ sort: { key: 'round_total', dir: 1 } }));
  assert.ok(asc.indexOf('李四') < asc.indexOf('张三'));
});

test('renderCompareHTML：勾选子集——隐藏的人不出现，提示已隐藏 N 人', () => {
  const html = renderCompareHTML(cstate({ hidden: ['2'] }));
  assert.match(html, /张三/);
  assert.doesNotMatch(html, /李四/);
  assert.match(html, /已隐藏 1 人/);
});

test('renderCompareHTML：深层-按身份——身份选择器(并集) + 选中身份的多指标列，未打过该身份显 —', () => {
  const s = cstate({ layer: 'deep', deepMode: 'byrole', role: '预言家' });
  s.rows['1'].full = { roles: [{ role: '预言家', n: 10, avg: 6.2, win: 60, mvp: 3, svp: 1, bgx: 0 }] };
  s.rows['2'].full = { roles: [{ role: '女巫', n: 5, avg: 5, win: 40, mvp: 0, svp: 0, bgx: 1 }] };
  const html = renderCompareHTML(s);
  assert.match(html, /选择身份/);       // 身份选择器
  assert.match(html, /预言家/); assert.match(html, /女巫/);   // 并集
  assert.match(html, /场次/); assert.match(html, /场均分/);   // 角色多指标列
  assert.match(html, /60%/);            // 张三 预言家 胜率
  assert.match(html, /—/);              // 李四 没打过预言家 → —
});

test('renderCompareHTML：深层-人×身份矩阵——身份成列、格=选中指标、点身份列排序', () => {
  const s = cstate({ layer: 'deep', deepMode: 'matrix', metric: 'avg', sort: { key: '预言家', dir: -1 } });
  s.rows['1'].full = { roles: [{ role: '预言家', n: 10, avg: 6.8, win: 60, mvp: 3, svp: 1, bgx: 0 }, { role: '平民', n: 5, avg: 6.0, win: 50, mvp: 0, svp: 0, bgx: 0 }] };
  s.rows['2'].full = { roles: [{ role: '预言家', n: 8, avg: 5.9, win: 50, mvp: 1, svp: 0, bgx: 1 }] };
  const html = renderCompareHTML(s);
  assert.match(html, /预言家/); assert.match(html, /平民/);   // 身份成列
  assert.match(html, /6\.8/); assert.match(html, /5\.9/);      // 场均分格
  assert.ok(html.indexOf('张三') < html.indexOf('李四'));       // 按预言家场均分降序 6.8>5.9
});

test('renderCompareHTML：深层-按身份，有身份可选但未选 → 提示先选身份', () => {
  const s = cstate({ layer: 'deep', deepMode: 'byrole', role: '' });
  s.rows['1'].full = { roles: [{ role: '预言家', n: 10, avg: 6.2, win: 60, mvp: 3, svp: 1, bgx: 0 }] };
  s.rows['2'].full = { roles: [{ role: '女巫', n: 5, avg: 5, win: 40, mvp: 0, svp: 0, bgx: 1 }] };
  assert.match(renderCompareHTML(s), /选择一个身份/);
});

test('renderCompareHTML：深层-按身份，全部失败 → 显示错误（不停在“选择一个身份/加载中”）', () => {
  const s = cstate({ layer: 'deep', deepMode: 'byrole', role: '' });
  s.rows['1'] = { fullErr: '炸了' }; s.rows['2'] = { fullErr: '炸了' };
  const html = renderCompareHTML(s);
  assert.match(html, /身份数据获取失败/);
  assert.doesNotMatch(html, /选择一个身份/);
});

test('renderCompareHTML：深层-按身份，加载完成但无身份数据 → 空状态', () => {
  const s = cstate({ layer: 'deep', deepMode: 'byrole', role: '' });
  s.rows['1'] = { full: { roles: [] } }; s.rows['2'] = { full: { roles: [] } };
  const html = renderCompareHTML(s);
  assert.match(html, /暂无可用的身份数据/);
  assert.doesNotMatch(html, /选择一个身份/);
});

test('refreshSession：解析 /api/session 下发的版本号 → appVersion', async () => {
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: 'n', exp: 1893456000, version: 'v1.2.3' }) });
  await refreshSession();
  assert.equal(appVersion(), 'v1.2.3');
});

test('renderCompareHTML：深层-数据仍在拉 → 加载中（非永久占位）', () => {
  // 默认 rows 只有 head、无 full/fullErr → 视为预热中
  const html = renderCompareHTML(cstate({ layer: 'deep', deepMode: 'matrix' }));
  assert.match(html, /正在加载身份数据/);
});

test('renderCompareHTML：深层-全部失败 → 显示错误，不再卡“加载中”', () => {
  const s = cstate({ layer: 'deep', deepMode: 'matrix' });
  s.rows['1'] = { fullErr: '炸了' }; s.rows['2'] = { fullErr: '炸了' };
  assert.match(renderCompareHTML(s), /身份数据获取失败/);
});

test('renderCompareHTML：深层-加载完成但无身份数据 → 空状态，不再卡“加载中”', () => {
  const s = cstate({ layer: 'deep', deepMode: 'matrix' });
  s.rows['1'] = { full: { roles: [] } }; s.rows['2'] = { full: { roles: [] } };
  assert.match(renderCompareHTML(s), /暂无可用的身份数据/);
});

test('renderCompareHTML：深层-HTTP200 部分降级(games_error, roles 空) → 判为失败，不误报“暂无”', () => {
  const s = cstate({ layer: 'deep', deepMode: 'matrix' });
  s.rows['1'] = { full: { roles: [], games_error: '逐场炸了' } };
  s.rows['2'] = { full: { roles: [], games_error: '逐场炸了' } };
  const html = renderCompareHTML(s);
  assert.match(html, /身份数据获取失败/);
  assert.doesNotMatch(html, /暂无可用的身份数据/);
});

test('renderCompareHTML：深层-一人失败、其余成功但空角色 → 提示部分失败，不伪装成“空”', () => {
  const s = cstate({ layer: 'deep', deepMode: 'byrole', role: '' });
  s.rows['1'] = { full: { roles: [], games_error: '逐场炸了' } };   // 失败(200 降级)
  s.rows['2'] = { full: { roles: [] } };                              // 成功但该作用域无对局
  const html = renderCompareHTML(s);
  assert.match(html, /部分选手的身份数据获取失败/);
  assert.doesNotMatch(html, /暂无可用的身份数据/);
  assert.doesNotMatch(html, /选择一个身份/);
});

// —— 布局分支 / 自定义 / 最优高亮（重设计新增）——
test('renderCompareHTML：≤4 人 → 卡片列布局，头像为矩形照片(cmpc-photo)', () => {
  const html = renderCompareHTML(cstate());
  assert.match(html, /class="cmpc"/);
  assert.match(html, /cmpc-photo/);
  assert.doesNotMatch(html, /cmp-tbl/);
});

test('renderCompareHTML：≥5 人 → 表格布局(cmp-tbl)，非卡片列', () => {
  const basket = [], rows = {};
  for (let i = 1; i <= 5; i++) {
    basket.push({ id: String(i), name: 'P' + i, avatar: '' });
    rows[String(i)] = { head: { comprehensive: [{ key: 'round_total', val: 100 + i }, { key: 'win_pct', val: 50 + i }] } };
  }
  const html = renderCompareHTML(cstate({ basket, rows }));
  assert.match(html, /cmp-tbl/);
  assert.doesNotMatch(html, /class="cmpc"/);
});

test('renderCompareHTML：自定义组——跨 好人/狼人 勾选项成行，带组前缀标签', () => {
  const s = cstate({ group: 'custom', custom: [['good', 'toulang_pct'], ['wolf', 'molang_pct']] });
  s.rows['1'].head.wolf = [{ key: 'molang_pct', val: 30 }];
  s.rows['2'].head.wolf = [{ key: 'molang_pct', val: 20 }];
  const html = renderCompareHTML(s);
  assert.match(html, /好人·投狼率/);   // 组前缀 + fmt 标签
  assert.match(html, /狼人·摸狼率/);
  assert.match(html, /自定义/);         // tab 存在
});

test('renderCompareHTML：最优高亮——只亮归一化指标(胜率/场均分取 max)，原始次数(场次/背锅)不亮', () => {
  const s = cstate({ group: 'custom', custom: [['comprehensive', 'win_pct'], ['comprehensive', 'round_point_avg'], ['comprehensive', 'round_total'], ['comprehensive', 'bgx_num']] });
  s.rows['1'].head.comprehensive = [{ key: 'win_pct', val: 58 }, { key: 'round_point_avg', val: 6.2 }, { key: 'round_total', val: 120 }, { key: 'bgx_num', val: 2 }];
  s.rows['2'].head.comprehensive = [{ key: 'win_pct', val: 61 }, { key: 'round_point_avg', val: 6.8 }, { key: 'round_total', val: 98 }, { key: 'bgx_num', val: 5 }];
  const html = renderCompareHTML(s);
  assert.match(html, /cmp-best">61%/);         // 胜率 61>58 最优
  assert.match(html, /cmp-best">6\.8/);        // 场均分 6.8>6.2 最优
  assert.doesNotMatch(html, /cmp-best">120/);  // 场次是原始次数 → 不亮
  assert.doesNotMatch(html, /cmp-best">2</);   // 背锅次数是原始次数 → 不亮
});

test('renderCompareHTML：卡片列-深层部分选手失败 → 卡头标 ⚠（不伪装成无数据）', () => {
  const s = cstate({ layer: 'deep', deepMode: 'matrix', metric: 'avg' });
  s.rows['1'] = { full: { roles: [{ role: '预言家', n: 10, avg: 6.2, win: 60 }] } };
  s.rows['2'] = { fullErr: '炸了' };
  const html = renderCompareHTML(s);
  assert.match(html, /class="cmpc"/);   // 2 人 → 卡片列
  assert.match(html, /cmp-err/);        // 失败选手卡头 ⚠，而非只显 —
});

test('renderCompareHTML：自定义-已选指标在当前作用域无人拥有时，选择器仍保留可取消', () => {
  const s = cstate({ group: 'custom', custom: [['wolf', 'molang_pct']] });   // 篮内无人有 wolf 数据
  const html = renderCompareHTML(s);
  assert.match(html, /toggleCompareCustom\('wolf','molang_pct'\)/);   // chip 仍在，可取消勾选
  assert.match(html, /狼人·摸狼率/);                                  // 该行仍渲染（值为 —）
});


// 这条守卫会挡下“新加了内联入口却忘了 Object.assign(window,...)”的漏挂（如 setSearchMode 一度漏挂）。
test('index.html 内联处理器都已挂到 window', () => {
  const html = readFileSync('./internal/server/web/index.html', 'utf8');
  const main = readFileSync('./internal/server/web/js/main.js', 'utf8');
  const block = main.match(/Object\.assign\(window,\s*\{([\s\S]*?)\}\)/)[1];
  const exposed = new Set(block.split(/[\s,]+/).filter(Boolean));
  const attrs = [...html.matchAll(/\son\w+="([^"]*)"/g)].map(m => m[1]).join(';');
  const called = new Set([...attrs.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
  const builtins = new Set(['if', 'for', 'while', 'return', 'event']);   // 控制流/全局，非本项目函数
  const missing = [...called].filter(n => !exposed.has(n) && !builtins.has(n));
  assert.deepEqual(missing, [], '未挂到 window 的内联处理器: ' + missing.join(', '));
});

// 上面的守卫只扫静态 index.html；各 JS 模块「动态生成的 HTML 字符串」里的内联处理器它看不到
// （如 events.js/compare.js 里 `onclick="..."` 与经 sortableTh('handler',...) 生成的排序表头）。
// 这条补扫这些文件：任一裸函数调用（排除 obj.method() 形式）或 sortableTh 的处理器名，都必须挂到 window，
// 否则点击时抛 ReferenceError（本条即挡下「新加动态处理器却忘了 Object.assign」）。
test('各 JS 模块动态生成的内联处理器都已挂到 window', () => {
  const main = readFileSync('./internal/server/web/js/main.js', 'utf8');
  const exposed = new Set(main.match(/Object\.assign\(window,\s*\{([\s\S]*?)\}\)/)[1].split(/[\s,]+/).filter(Boolean));
  const builtins = new Set(['if', 'for', 'while', 'return', 'event', 'this']);
  const missing = new Set();
  for (const f of ['ui.js', 'compare.js', 'events.js', 'options.js']) {
    const src = readFileSync('./internal/server/web/js/' + f, 'utf8');
    for (const attr of src.matchAll(/\son\w+="([^"]*)"/g)) {
      const inline = attr[1].replace(/\$\{[^}]*\}/g, '');   // 去掉 ${...} 插值（那是生成期调用，如 esc()），只留真正的内联处理器
      for (const call of inline.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (!exposed.has(call[1]) && !builtins.has(call[1])) missing.add(call[1]);
      }
    }
    for (const st of src.matchAll(/sortableTh\(\s*'([^']+)'/g)) {
      if (!exposed.has(st[1]) && !builtins.has(st[1])) missing.add(st[1]);
    }
  }
  assert.deepEqual([...missing], [], '动态 HTML 里未挂到 window 的处理器: ' + [...missing].join(', '));
});

test('首页：个人数据、赛事数据和华山工具箱同级，常用功能直接可见', () => {
  const html = readFileSync('./internal/server/web/index.html', 'utf8');
  const options = readFileSync('./internal/server/web/js/options.js', 'utf8');
  const visibleCopySources = ['ui.js', 'compare.js', 'events.js', 'options.js', 'rules.js']
    .map(file => readFileSync('./internal/server/web/js/' + file, 'utf8')).join('\n');
  assert.match(html, /狼人杀的最高境界，<br>就是修身养性。/);
  assert.match(html, /数据来自华山论剑官方 · 登录信息仅用于本次查询 · <span class="home-credit">本工具由 <b>Will<\/b> 制作 · © 2026<\/span>/);
  const choices = html.match(/<div class="home-choices">([\s\S]*?)<\/div>/)[1];
  assert.ok(choices.indexOf('个人数据') < choices.indexOf('赛事数据'));
  assert.ok(choices.indexOf('赛事数据') < choices.indexOf('华山工具箱'));
  assert.match(html, /id="tools-page"[\s\S]*id="rules-open"[\s\S]*华山规则/);
  const actions = html.match(/<section class="home-actions"[\s\S]*?<\/section>/)[0];
  for (const label of ['切换主题', '使用说明', '分享给朋友', '更新日志', '检查更新', '退出程序']) assert.match(actions, new RegExp(label));
  assert.doesNotMatch(html, /id="opt"|id="optmenu"|id="copy-token"|aria-label="功能菜单"/);
  assert.doesNotMatch(html, /不用再|后续还会|以后新增|继续扩充|官方接口|不下发到页面|本机处理/);
  assert.doesNotMatch(visibleCopySources, /不用再点右上角|不用再找右上角|工具箱会继续扩充|后续都可以放到这里|数据为打开程序时抓取的快照|已达安全上限|上方选|暂时无法计算|Bearer 前缀|在后台计算|按需加载/);
  assert.match(options, /<details class="about-submenu">[\s\S]*登录与 Token[\s\S]*copyLoginToken\(\)[\s\S]*<\/details>/);
});

test('cmpVer：语义化版本比较，忽略前导 v 与预发布后缀', () => {
  assert.equal(cmpVer('0.3.0', '0.2.0'), 1);
  assert.equal(cmpVer('v0.2.0', '0.2.0'), 0);
  assert.equal(cmpVer('0.2.0-beta', 'v0.2.0'), 0);   // 去后缀后相等
  assert.equal(cmpVer('0.2.1', '0.2.0'), 1);
  assert.equal(cmpVer('0.2.0', '0.10.0'), -1);       // 数值比较，非字典序
  assert.equal(cmpVer('1.0', '1.0.0'), 0);
});

test('latest：检查更新走本地 /api/latest', async () => {
  let seen;
  globalThis.fetch = async url => { seen = url; return resp({ body: JSON.stringify({ configured: true, version: '0.3.0', url: 'https://x/y', notes: 'n' }) }); };
  const d = await latest();
  assert.equal(seen, '/api/latest');
  assert.equal(d.version, '0.3.0');
});

test('shareText：分享文案包含 Windows 和 Apple Silicon Mac 链接', () => {
  const text = shareText({ url: 'https://x/legacy.exe', downloads: {
    windows_amd64: 'https://x/win.exe', mac_arm64: 'https://x/mac-arm',
  } });
  assert.match(text, /Windows：https:\/\/x\/win\.exe/);
  assert.match(text, /Mac（Apple 芯片）：https:\/\/x\/mac-arm/);
  assert.doesNotMatch(text, /legacy\.exe/);
});

test('autoCheckUpdate：有新版本才静默弹窗；已最新 / 服务器错误一律不打扰、不报错', async () => {
  const about = { innerHTML: '', style: {} };
  globalThis.document = { querySelector: s => (s === '#about' ? about : null) };
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: 'n', exp: 1893456000, version: 'v0.2.1' }) });
  await refreshSession();                       // 当前版本 = v0.2.1
  // 有新版本 → 静默弹窗
  globalThis.fetch = async () => resp({ body: JSON.stringify({ configured: true, version: '0.3.0', url: 'https://x/y.exe', notes: 'n' }) });
  about.innerHTML = '';
  await autoCheckUpdate();
  assert.match(about.innerHTML, /发现新版本 v0\.3\.0/);
  assert.match(about.innerHTML, /立即下载新版本/);
  // 已是最新 → 不弹
  globalThis.fetch = async () => resp({ body: JSON.stringify({ configured: true, version: '0.2.1' }) });
  about.innerHTML = '';
  await autoCheckUpdate();
  assert.equal(about.innerHTML, '');
  // 服务器错误 → 静默、不抛错
  globalThis.fetch = async () => resp({ ok: false, status: 500, body: '' });
  about.innerHTML = '';
  await autoCheckUpdate();
  assert.equal(about.innerHTML, '');
  // 启动竞态：当前版本尚未就绪(空) → 不把任何远端版本误判为新版
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: 'n', exp: 1893456000 }) }); // 无 version
  await refreshSession();
  assert.equal(appVersion(), '');
  globalThis.fetch = async () => resp({ body: JSON.stringify({ configured: true, version: '9.9.9', url: 'https://x/y.exe' }) });
  about.innerHTML = '';
  await autoCheckUpdate();
  assert.equal(about.innerHTML, '');
});
