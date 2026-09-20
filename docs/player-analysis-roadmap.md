# 选手数据分析执行计划(Roadmap)

> 本文件是**跨 session 的执行计划与进度记录**,不是知识库(领域判断见 `docs/knowledge/player-analysis/`)。
> 每次推进后更新对应条目的状态与「进度备注」。新 session 从这里接着做。
>
> 状态图例:✅ 完成 · 🔄 进行中 · ⬜ 未开始 · ⏸ 阻塞
> 最近更新:2026-09-20 · 分支:`player-traits-and-crawler`

## 使用方式

1. 开工前先读本文件最新状态,再读 `docs/knowledge/player-analysis/` 对应知识页。
2. Python 用于**研究/离线原型与口径验证**;确定性口径稳定后**固化进 Go builder**(`cmd/player-analysis-build`)。出厂产品只用 Go 标准库 + 原生 ES Modules,不带 Python。
3. 数据源:本地 MySQL(见 Phase 0),源表 `games/game_players/players/player_stats`,派生表 `analysis_*`。

## 不可违反的护栏(每个阶段都适用)

- **无数据泄漏**:评价某局的难度/赛前强度,只能用该局**开赛前**已发生的对局;目标局及其后数据不得进入。按 `play_date` 排序,同日用轮次/`game_id` 稳定次序并披露近似。
- **不合成单一「含金量分」**:难度拆成对手强度/队友支持/预计胜率/结果超预期/局内执行/覆盖置信度,分开报告。禁止「胜利含金量高 ⇒ 本人发挥一定好」。
- **团队 ≠ 个人**:团队赢下强敌只说明这支队扛住了;归个人须有独立局内执行证据。团队胜利、个人存活、MVP 机械耦合,算一个信号。
- **T2 不越界到 T3**:发言内容、夜间指挥、心理动机不设维度(C 档)。普通狼刀归团队级。
- **同阵营内比较**:好人/狼人分别建基线;每个率带真实分子/分母;分母定置信度(0–9 线索 / 10–29 低 / 30–79 中 / 80+ 较高);小样本向阵营/赛季基线收缩。
- **可复现可回溯**:每条派生结果能通过 `analysis_run_id` + `game_id` 回到源数据与算法版本。

---

## 现状快照

- **已建**:8 个指标 + 分布标签(胜率、MVP率、存活率、找狼命中、警徽命中、倒钩率、悍跳率、自刀率),周期切片(全生涯/自然年/最近30·50·100),P10/30/70/90 五档。
- **未建**:`matchup-impact` 全部(赛前强度快照、预计胜率、结果超预期)= **0 实现**;`player-traits.md` 里大部分特性率未建。

---

## Phase 0 — 环境与基线 ✅

- ✅ 本地 MySQL 8.4.11(`F:/mysql-local`,root 无密码,127.0.0.1:3306),导入 `huashan-export.sql.gz`(13,782 局)。
- ✅ `player-analysis-build -rebuild` → run 1 ready。审计:解析失败 2/13782(源 form2 残缺,已隔离)、投票分母自洽、标签参照组符合 ≥30 门槛、档位分布贴合 P10/30/70/90。
- **进度备注**:启动命令与细节见记忆 `local-mysql-pipeline`。失败局 id 30193、30323。

## Phase 1 — Python 研究台 ✅

- ✅ 离线 Python 环境(pandas/numpy/statsmodels/scikit-learn/matplotlib + pymysql/sqlalchemy),**只读**连本地 MySQL。
- ✅ 研究目录 `research/`(`db.py` 连接助手、`sanity_check.py`、`requirements.txt`、`README.md`);可再生产物放 `research/output/`(已 gitignore)。
- ✅ `research/sanity_check.py` 跑通:读到 run 1、覆盖率、各切片周期行数。
- **进度备注**:Python 3.13 全局环境;DSN 可用 `HUASHAN_DSN` 覆盖,默认 `root@127.0.0.1:3306/huashan`。换机 bootstrap 步骤见 `research/README.md`。

## Phase 2 — matchup-impact 原型(核心,Python)🔄

对应 `docs/knowledge/player-analysis/matchup-impact.md`。

- ✅ **2a 赛前强度快照**:`pregame_strength.py`,v0=仅用此前对局的同阵营胜率、向阵营基线收缩,无泄漏(首登场=基线,leak diff 0.00)。
- ✅ **2b 对手强度 / 队友支持**:每局聚合对方阵营与本方其他玩家的赛前强度。
- ✅ **2c 预计胜率模型**(round 1):`expected_win.py`,逻辑回归 + 赛季/版型/年份控制,校准良好。
- ✅ **2d 结果超预期残差**(round 1):`resid_good = 实际 − 预计`,已产出并可排序。
- ✅ **2e 局内执行字段**(round 1):`execution.py`,好人 day-vote 找狼命中相对全场(`above_field`)、是否带警徽、赢局;与难度残差挂接。1214 个"个人投票带队"候选(93 带警徽),这些局均值 p_good_win 0.328、resid_good +0.672。skill 命中与关键放逐轮加权留 round 2。
- 🔄 **2f 校验**:校准曲线已画;已知强/弱选手直觉核对待做。
- **进度备注(round 1 关键发现)**:v0 赛前强度**几乎不预测单局胜负**(Brier 0.2188 vs 基线 0.2206,预测区间压缩在 0.21–0.56)。单局方差大、阵容平衡主导。→ **round 2**:强度换成复合口径(找狼命中率+存活+按身份条件化+近期加权),预计胜率加入身份构成特征;并评估"成色"是否应更依赖个人 2e 局内执行而非团队残差。

## Phase 3 — 指标集扩展(traits 落地,先 Python 验口径)⬜

对应 `docs/knowledge/player-analysis/player-traits.md`,每条含数据判据 + 事件分母 + 置信度。

- ⬜ 好人:站对边率、站对边却被放逐、站错边却活到终局、胜局 vs 败局投票正确率(分开)、D3+ 残局存活与贡献、平民 D2+ 夜死率。
- ⬜ 狼人:冲锋后存活、倒钩后存活、真预言家清除率、普通狼 D3+ 存活与后期推进、梦魇恐惧/狼美人魅惑对神率。
- ⬜ 跨角色:拿好人 vs 拿狼的存活/命中对比(人狼一致性)、真预言家 vs 悍跳狼对跳博弈胜负。
- ⬜ 读感:被验率及被查杀/发金水比例。
- ⬜ 通用:方向一致性、MVP 率与得分方差、胜率与场均落差。
- **进度备注**:round 1 已在 Python 抽出**单局 A 档事实**(`research/game_facts.py` → `output/game_facts.csv`,grain=(game_id,seat))。已标:阵营/身份/胜负、最终存活、死亡日/相位/死因(枚举)、存活天数、MVP/SVP/背锅、找狼投票+技能命中(合并)、弃票、悍跳(日+顶替身份)、自爆日、冲锋/倒钩、被自刀日、被验(查杀/金水)。暂缓:站对边(需真预言家识别)、屠边方向、改票(schema 每人每天一票、无重投)。这些是 traits 的单局分子,冷启动即可标(标为线索,够场次再升级)。

## Phase 4 — 固化进 Go builder ⬜

- ⬜ 口径稳定后,把 Phase 2/3 的确定性计算移植进 `cmd/player-analysis-build`。
- ⬜ 新增 schema 表(如 `analysis_pregame_strength`、`analysis_matchup`、`analysis_result_residual`)与 metric 定义;保持增量刷新与全量重建两条路径。
- ⬜ 扩展 `validateBuild` 覆盖新表;更新 `schema.sql` 视图。
- **进度备注**:_(待填)_

## Phase 5 — 读取侧与产品接入 ⬜

- ⬜ **(上次遗留)** 端到端抽查 `v_player_ability_labels` / `v_player_profile`:取高局数选手核对分子/分母/原值/收缩值/档位/百分位成链、四类标签各归其位。
- ⬜ 视图/接口暴露给桌面版与网页;按 AGENTS.md 保持跨端一致性;更新使用说明与 FAQ。
- **进度备注**:_(待填)_

---

## 数据质量发现(需处理)

- ~~**一个 player_id 占多座位**(2026-09-20 发现)~~ **已修(2026-09-20)**:52 局中同一 `player_id` 占多座位(如 game 30139 玩家 1133 占 seat 2/6;game 32907 玩家 7103「npc」占 6 座),经查为**官方 payload 本身损坏**。修法:爬虫 `store()` 存局时校验名单并标注 `games.roster_ok`/`roster_issue`(`duplicate_player_seats` 等);新增 `player-crawl -migrate` 无令牌离线回填(已对现库回填,52 局标为 `duplicate_player_seats`);构建器排除 `roster_ok=0` 的局(记 `parse_error`)。run 2 复核:invalid 54(52 名单 + 2 form2),facts 中重复 (game_id,player_id) 归零。

## 待定问题(需产品决策)

- 预计胜率模型的复杂度上限(逻辑回归够用,还是要更强模型)?
- 跨规则版本(手册版型变化)如何切分/是否只做同版型内比较?
- ~~研究目录是否进 git;`huashan-export.sql.gz` 是否用 git-lfs 或保持本地忽略。~~ **已定(2026-09-20)**:`research/` 脚本进 git,`research/output/` 忽略;`huashan-export.sql.gz` 用 Git LFS 提交以便换机复现。
- 局内执行"个人带队"证据的最小组合(至少两个非重复信号)如何固定。
- LFS 推送目标:GitHub 与 Gitee 的 LFS 存储处理不同,推送前确认目标。

## 决策记录

- 2026-09-20:确认 Python 仅用于研究/离线,确定性口径固化进 Go;难度拆字段不合成单分;先做 Phase 2 原型再扩指标(方向待用户最终确认)。
- 2026-09-20:**可移植性模型**——一切派生结果确定性可复现。提交源(dump 走 LFS)+ 代码(Go builder、`research/` 脚本)+ 计划;**不**提交 MySQL 派生表与 `research/output/` 可再生产物,换机时按 `research/README.md` 重算。
