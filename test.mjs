// 前端单元测试：直接 import ES 模块（无需 vm/正则抽取）。运行：node --test test.mjs
// 计算类逻辑（聚合/筛选/候选/阵营归类/分页）已下沉到 Go(internal/player)，相应用例见 player_test.go；
// 这里只测“展示层”：配色、技能/投票/标记文案、赛区名解析、HTML 构造器、以及只连本地的 api 薄壳。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  skillLabel, roleColor, roleWeight, campColor, seatVotes, seatSkills, skillText, uniq, isWolf, resolveZone, fmt, isGoodCamp,
} from './internal/server/web/js/format.js';
import { renderDetailHTML, renderGameHTML, detailLoadingHTML, gateHTML, prefetchPlayer, rankByRelevance } from './internal/server/web/js/ui.js';
import { searchPlayers, detail, game, latest, refreshSession, setAuthLostHandler, tokenValid, sessionReason, testMode, appVersion, startHeartbeat, stopHeartbeat, quitApp } from './internal/server/web/js/api.js';
import { cmpVer } from './internal/server/web/js/options.js';

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

test('renderDetailHTML：完整渲染——姓名/战力/门派/逐场行/统计标签/荣誉/刷新按钮', () => {
  const html = renderDetailHTML(state({}));
  assert.match(html, /张三/);
  assert.match(html, /1234/);              // 战力值（原样数值）
  assert.match(html, /门派A/);
  assert.match(html, /openGame\(11\)/);
  assert.match(html, /共 1 场/);
  assert.match(html, /🎯 综合/);
  assert.match(html, /总场次/);            // fmt 把 round_total 译成中文标签（页面做）
  assert.match(html, /山东 S6 冠军/);       // zoneName(SD,joined)→山东赛区→去“赛区”；code 1→冠军
  assert.match(html, /100%/);              // 胜率由 comprehensive.win_pct 现格式化
  assert.match(html, /10%/);               // 投狼率来自 good.toulang_pct
  assert.match(html, /infohint/);          // 数据说明 ⓘ 提示
  assert.match(html, /关闭本程序再重新打开/); // 提示文案（缓存无自动刷新，关掉重开取最新）
  assert.doesNotMatch(html, /refreshPlayer/); // “刷新缓存”交互已移除
});

test('测试版本：个人信息显示低调水印，正式版本不显示', () => {
  assert.match(renderDetailHTML(state({ testMode: true })), /class="test-watermark"[^>]*>测试版本</);
  assert.doesNotMatch(renderDetailHTML(state({ testMode: false })), /test-watermark/);
  assert.match(styles, /\.test-watermark\{[^}]*opacity:\.08/);
  assert.match(styles, /\.test-watermark\{[^}]*font-size:clamp\(52px,8vw,76px\)/);
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
  assert.match(html, /共 1 场/);
});

test('renderDetailHTML：战绩失败 → 战绩区错误、队伍名占位；截断提示', () => {
  const errHtml = renderDetailHTML(state({ model: { games_error: '战绩炸了', games: [] } }));
  assert.match(errHtml, /获取失败：战绩炸了/);
  const truncHtml = renderDetailHTML(state({ model: { games_trunc: true } }));
  assert.match(truncHtml, /已达安全上限/);
});

test('renderDetailHTML：两阶段头部——gamesLoading 且首页未到 → 逐场纯占位、角色/队伍“加载中”', () => {
  const html = renderDetailHTML(state({ gamesLoading: true, model: { games: [], roles: [], teams: [] } }));
  assert.match(html, /正在加载逐场战绩/);        // 无首页行：逐场区纯占位
  assert.doesNotMatch(html, /无战绩/);            // 不再误显示“无战绩”
  assert.match(html, /加载中…/);                  // 角色/队伍占位
  assert.match(html, /张三/);                     // 头部（来自 stats）照常渲染
  assert.match(html, /🎯 综合/);                  // 综合方块来自 stats，头部阶段即可用
});

test('renderDetailHTML：首屏预览——gamesLoading 且已有首页行 → 渲染表格但禁用筛选/排序、显示总场数', () => {
  const html = renderDetailHTML(state({ gamesLoading: true, model: { games_total: 9999, games_total_known: true, roles: [] } }));
  assert.match(html, /openGame\(11\)/);          // 首屏行已渲染（model 默认含一行 game_id=11）
  assert.match(html, /共 9999 场/);               // 总数确定时显示“共 N 场”
  assert.match(html, /逐场加载中/);
  assert.doesNotMatch(html, /setGF/);             // 筛选栏禁用（不渲染 qfbar）
  assert.doesNotMatch(html, /sortGames/);         // 排序表头禁用
  assert.doesNotMatch(html, /正在加载逐场战绩/);   // 有首页行时不再显示纯占位
  assert.match(html, /🎭 角色表现/);              // 角色区仍在
  assert.match(html, /加载中…/);                  // 角色“统计中”占位
});

test('renderDetailHTML：首屏预览 总数未知 → 显示“已显示前 N 场·完整数量加载中”，不谎报确定总数', () => {
  const html = renderDetailHTML(state({ gamesLoading: true, model: { games_total: 1, games_total_known: false, roles: [] } }));
  assert.match(html, /已显示前 1 场/);
  assert.match(html, /完整数量加载中/);
  assert.doesNotMatch(html, /共 1 场 · 逐场加载中/);   // 未知时不写“共 N 场”
  assert.doesNotMatch(html, /共 -1 场/);
});

test('renderDetailHTML：gamesLoading=false（逐场已到）→ 正常渲染表格，无加载占位', () => {
  const html = renderDetailHTML(state({ gamesLoading: false }));
  assert.match(html, /openGame\(11\)/);
  assert.doesNotMatch(html, /正在加载逐场战绩/);
});

test('renderDetailHTML：逐场出错优先于 gamesLoading（不显示加载占位）', () => {
  const html = renderDetailHTML(state({ gamesLoading: true, model: { games_error: '炸了', games: [] } }));
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
  assert.match(renderDetailHTML(state({ model: two })), /共 2 场/);
  assert.match(renderDetailHTML(state({ model: two, gf: { result: 'w' } })), /共 1 场/);   // 只剩胜场
  assert.match(renderDetailHTML(state({ model: two, gf: { camp: 'wolf' } })), /共 1 场/);  // isGoodCamp 客户端分阵营
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
  assert.match(message, /无法连接本地服务/);
  assert.match(message, /手动关闭本页/);
  assert.equal(closes, 1);
  await assert.rejects(() => game(2), e => e.name === 'LocalServerError');
  await assert.rejects(() => refreshSession(), e => e.name === 'LocalServerError');
  assert.equal(closes, 1, '并发或后续失败不应重复弹窗、重复关闭');
  delete globalThis.window;
});

test('测试版本到期：提示重新打开并尝试关闭页面', async () => {
  let message = '', closes = 0;
  globalThis.window = { alert: s => { message = s; }, close: () => { closes++; } };
  globalThis.fetch = async () => resp({ ok: false, status: 410, body: JSON.stringify({ error: { code: 'test_expired' } }) });
  await assert.rejects(() => game(1), e => e.name === 'TestVersionExpiredError' && e.status === 410);
  assert.match(message, /测试版本使用已结束/);
  assert.match(message, /重新打开程序/);
  assert.equal(closes, 1);
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
  assert.match(gateHTML('expired'), /已过期/);       // 精确原因：过期
  assert.match(gateHTML('network'), /连不上华山服务器/); // 精确原因：网络
  assert.match(gateHTML('server'), /服务器暂时异常/);   // 精确原因：服务器
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
  globalThis.fetch = async url => { seenUrl = url; return resp({ body: JSON.stringify({ nick: '阿三', exp: 1893456000, test_mode: true }) }); };
  assert.equal(await refreshSession(false), true);
  assert.equal(seenUrl, '/api/session');
  assert.equal(testMode(), true);
  await refreshSession(true);
  assert.equal(seenUrl, '/api/session?refresh=1');

  globalThis.fetch = async () => resp({ ok: false, status: 500, body: '' });
  assert.equal(await refreshSession(), false);
});

test('prefetchPlayer：测试版关闭后台预热——姓名搜索预热不扣额度（ID 直达仍按一次查询计）', async () => {
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: 'n', exp: 1893456000, test_mode: true }) });
  await refreshSession();
  assert.equal(testMode(), true);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return resp({ body: '{}' }); };
  prefetchPlayer('99'); prefetchPlayer('99');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls, 0);   // 测试版一律不发预热请求
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

test('prefetchPlayer：正式版打全量 detail(view=cmp-<id>)，在途去重、settle 后可再预热', async () => {
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: 'n', exp: 1893456000 }) });
  await refreshSession();   // test_mode 缺省=false，退出测试版
  assert.equal(testMode(), false);
  const seen = [];
  globalThis.fetch = async url => { seen.push(url); return resp({ body: JSON.stringify({ player: { name: 'x' } }) }); };
  prefetchPlayer('42'); prefetchPlayer('42');   // 在途去重：只发一次
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\/api\/players\/detail\?id=42&zone=ALL&view=cmp-42$/);
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
  globalThis.fetch = async () => resp({ body: JSON.stringify({ nick: 'n', exp: 1893456000, version: 'v1.2.3-test' }) });
  await refreshSession();
  assert.equal(appVersion(), 'v1.2.3-test');
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

// index.html 的静态内联处理器（onclick/onkeydown/...）必须挂到 window——ES module 的 import 不进全局。
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

test('cmpVer：语义化版本比较，忽略前导 v 与 -test 后缀', () => {
  assert.equal(cmpVer('0.3.0', '0.2.0'), 1);
  assert.equal(cmpVer('v0.2.0', '0.2.0'), 0);
  assert.equal(cmpVer('0.2.0-test', 'v0.2.0'), 0);   // 去后缀后相等
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
