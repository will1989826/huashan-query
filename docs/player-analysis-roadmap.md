# 选手数据分析执行计划(Roadmap)

> 本文件是**跨 session 的执行计划与进度记录**,不是知识库(领域判断见 `docs/knowledge/player-analysis/`)。
> 每次推进后更新对应条目的状态与「进度备注」。新 session 从这里接着做。
>
> 状态图例:✅ 完成 · 🔄 进行中 · ⬜ 未开始 · ⏸ 阻塞
> 最近更新:2026-09-21 · 分支:`player-traits-and-crawler`

## 接续指引(clear 后从这里开始)

**当前状态**:解读框架已固化进 Go(A)并接入桌面「特性画像」tab(B,T0 官方+T2 自算双视图均上线)。framework 单一事实源 `internal/analysis/framework_rules.json`,Go 产出 `internal/server/web/framework.json`(embed)。live 自算走 `/api/players/trait`(`player.ComputeGameFacts`+`analysis.Agg`,与离线 builder 同口径、7 选手校验一致)。离线自查:`research/applier.py 名字`(本地 MySQL 需在跑,**run 7,algorithmVersion=t2-labels-v5**;Windows 控制台加 `PYTHONIOENCODING=utf-8 PYTHONUTF8=1`)。

**Go builder 已算出的指标(run 7, analysis_metric_values)**:胜率/MVP/尽力/背锅/存活/找狼(投+技能)/警长当选/倒钩占比/悍跳/悍跳得警徽/暴露后存活/自爆;冲锋后存活/倒钩后存活/D3+存活/胜局找狼/败局找狼/被验(查杀·金水);站对边率、站对边被放逐率、平民夜死率、神职存活率、梦魇恐惧对神率、狼美人魅惑对神率;**v5**:真预言家第一天对决胜率、悍跳第一天对决胜率(替换旧全场口径)、警徽投对真预言家率、警徽冲锋率、警徽倒钩率、投警徽率。**已删**:真预言家清除率(松口径含夜刀,被第一天对决取代)。

**✅ 刚完成(2026-09-21)**:v5 六个指标固化进 Go builder(新增 5 个 fact 列+5 个 period 列+ensureAnalysisColumns 迁移+scan/insert/agg,metricDefinitions 删 seer_cleared_rate、加 4 个警徽指标、重定义两个对决为第一天口径),algorithmVersion→t2-labels-v5,run 7 全量重建。**口径交叉校验**:Go pooled 与 Python 原型(`research/duel_badge.py`)完全一致——真预言家第一天对决胜 44.9%、悍跳 37.3%、好人警徽投对真预言家 53.6%、狼警徽冲锋(投悍跳)56.9%、狼警徽倒钩(投真预言家)39.8%。framework/applier 已接入并按事实(补充)文案规范呈现。

**✅ A、B 均已完成(见下)。接下来是可选深化**:
- ✅ **A. 固化 framework 生成进 Go(已完成 2026-09-21)**:`cmd/player-analysis-build/framework.go` 读 `internal/analysis/framework_rules.json`(规则/文案/T0定义单一事实源)+ 已建库分布,产出 `internal/analysis/framework.json`;`-framework` 标志可只重算 framework、不重建全库;Go 与 Python 产出交叉校验语义完全一致(24 T0/258 T2/全部规则)。
- ✅ **B. 桌面"特性画像"新 tab(已完成 2026-09-22)**:T0 官方视图 + T2 自算视图(多范围)均上线(见 Phase 5 step 4)。共享 Go 口径:`internal/player.ComputeGameFacts` + `internal/analysis.Agg`;`/api/players/trait` 端点后台逐场重建,返回 career+最近20/50/100+各自然年多范围。**已补齐**:①小样本收缩——framework 带 baseline+prior_weight(20),前端排名前先 `smoothed=(num+baseline*prior)/(den+prior)` 再比 deciles,分母<10 标"样本少·不排名"、<30 标"·偏少";②多范围(生涯/最近50/最近20/最新自然年,recent-N 为同阵营最近N场);③**builder 已切到共享 `ComputeGameFacts`**,run 8 与 run7 快照 1,101,042 行 0 mismatch、双实现合一。**遗留**:小程序端(先不做)。
- ⬜ **未做的分析深化**(独立于 A/B):见 Phase 3 剩余(普通狼 D3+ 后期推进、人狼一致性对比等)、matchup-impact 的关键放逐轮加权。
- ⬜ **未做的分析深化**(独立于 A/B):见 Phase 3 剩余(普通狼 D3+ 后期推进、人狼一致性对比等)、matchup-impact 的关键放逐轮加权。

**第一天对决口径(v5 敲定)**:只算第一天,以是否熬过第一天(死亡日为空或≥2,死因不限)为准。真预言家胜=预言家熬过+悍跳全部第一天出局;悍跳胜=悍跳熬过+第一天有好人出局(真预言家或其他好人——可能中假查杀);两人都活且无好人出局=平。警徽:无候选/上警字段、弃票未记录(重建只存 vote_jinhui≠0 的票),故砍掉"上警率/弃票率",改用**投警徽率**(有竞选且活到竞选时的局里真投了票的比例)作"爱上警"代理(低=常自己上警/弃票),警下投票去向只算真投了的、排除对跳双方本人。

**协作方式**:用户非分析背景,要我主导方法、只在真决策上问;联动比单指标重要,画像以联动为主、指标用同侪百分位(前/后 X%)。

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

## Phase 2 — matchup-impact 原型(核心,Python)✅(synthesis 完成,难度降级为背景)

对应 `docs/knowledge/player-analysis/matchup-impact.md`。

- ✅ **2a 赛前强度快照**:`pregame_strength.py`,v0=仅用此前对局的同阵营胜率、向阵营基线收缩,无泄漏(首登场=基线,leak diff 0.00)。
- ✅ **2b 对手强度 / 队友支持**:每局聚合对方阵营与本方其他玩家的赛前强度。
- ✅ **2c 预计胜率模型**(round 1):`expected_win.py`,逻辑回归 + 赛季/版型/年份控制,校准良好。
- ✅ **2d 结果超预期残差**(round 1):`resid_good = 实际 − 预计`,已产出并可排序。
- ✅ **2e 局内执行字段**(round 1):`execution.py`,好人 day-vote 找狼命中相对全场(`above_field`)、是否带警徽、赢局;与难度残差挂接。1214 个"个人投票带队"候选(93 带警徽),这些局均值 p_good_win 0.328、resid_good +0.672。skill 命中与关键放逐轮加权留 round 2。
- 🔄 **2f 校验**:校准曲线已画;round 2 复合强度对比已做(见决策记录)。
- ✅ **synthesis 成色视图**:`game_quality.py` → `game_quality.csv`,每人每局,**个人执行为主轴**(好人:找狼相对全场+警徽+存活;狼:悍跳得警徽/冲锋倒钩/暴露后存活),对手强度/预计胜率/残差仅作背景标签,不合成单分,分子分母保留。round-2 TODO:关键放逐轮加权、清真预言家(需真预言家识别)。
- **进度备注(round 1 关键发现)**:v0 赛前强度**几乎不预测单局胜负**(Brier 0.2188 vs 基线 0.2206,预测区间压缩在 0.21–0.56)。单局方差大、阵容平衡主导。→ **round 2**:强度换成复合口径(找狼命中率+存活+按身份条件化+近期加权),预计胜率加入身份构成特征;并评估"成色"是否应更依赖个人 2e 局内执行而非团队残差。

## Phase 3 — 指标集扩展(traits 落地,先 Python 验口径)🔄

对应 `docs/knowledge/player-analysis/player-traits.md`,每条含数据判据 + 事件分母 + 置信度。

- ✅ 好人:站对边率、站对边却被放逐、D3+ 残局存活、平民 D2+ 夜死率、神职存活率(v4 已入库并接进 framework)。⬜ 站错边却活到终局、胜局 vs 败局投票正确率已分开(won/lost_findwolf_rate)。
- ✅ 狼人:冲锋后存活、倒钩后存活、真预言家清除率、梦魇恐惧/狼美人魅惑对神率(v4)。🔬 普通狼 D3+ 存活与后期推进(`deepen.py` 已研究:+11.9pt 但含团队耦合、个体 corr 0.265 弱;未固化,见决策记录)。
- ✅ 跨角色:真预言家 vs 悍跳狼对跳博弈胜负(seer_duel_win_rate / hantiao_duel_win_rate,v4)。⬜ 拿好人 vs 拿狼的存活/命中对比(人狼一致性,见联动规则层)。
- ✅ 读感:被验率及被查杀/发金水比例(seer_checked_rate)。
- ⬜ 通用:方向一致性、MVP 率与得分方差、胜率与场均落差。
- **进度备注**:round 1 已在 Python 抽出**单局 A 档事实**(`research/game_facts.py` → `output/game_facts.csv`,grain=(game_id,seat))。已标:阵营/身份/胜负、最终存活、死亡日/相位/死因(枚举)、存活天数、MVP/SVP/背锅、找狼投票+技能命中(合并)、弃票、悍跳(日+顶替身份)、自爆日、冲锋/倒钩、被自刀日、被验(查杀/金水)。暂缓:站对边(需真预言家识别)、屠边方向、改票(schema 每人每天一票、无重投)。这些是 traits 的单局分子,冷启动即可标(标为线索,够场次再升级)。
- **round 2 已聚合到选手级**:`research/player_traits.py` → `output/player_traits.csv`,长表,按 全生涯/自然年/最近30·50·100 × 阵营,每条特性带分子/分母/置信度(0-9线索/10-29低/30-79中/80+较高)。已覆盖:win_rate、survival_rate、findwolf_rate、above_field_mean、badge_carry_rate(好人)、hantiao_rate、hantiao_badge_rate、exposed_survival_rate、self_destruct_rate(狼)。276480 行 / 4779 人。**未做**:同类分布五档标签(builder 已有机制)、`player-traits.md` 里站对边/冲锋倒钩后存活/D3+残局/屠边等其余特性。

## Phase 4 — 固化进 Go builder 🔄

- ✅ 把稳定的**率类特性**固化进 `cmd/player-analysis-build`:新增单局事实列 `find_skill_events`/`find_skill_hits`(好人找狼技能命中),周期新增 `badge_games`/`hantiao_badge_games`/`exposed_games`/`exposed_survived_games`;`metricDefinitions` 加 `findwolf_rate`(投+技能合并)、`badge_carry_rate`、`hantiao_badge_rate`、`exposed_survival_rate`。现成的同类分布五档 + 百分位 + 置信度机制自动打标签。
- ✅ `algorithmVersion` → `t2-labels-v2`;`ensureAnalysisColumns` 幂等 ALTER 迁移让旧库自动补列;全量重建路径已跑通(run 3)。
- ✅ **口径交叉校验**:Go `findwolf_rate`(玩家 748)= 321/602 = 0.5332,与 Python 原型完全一致。
- **未固化(有意)**:赛前强度/残差表(难度已降级为背景标签,不急);`above_field`(带符号、不适配 rate+baseline 标签机制,留研究层)。
- ⬜ 其余 `player-traits.md` 特性(站对边、冲锋/倒钩后存活、D3+ 残局、屠边)待补。
- **进度备注**:新指标经 `v_player_ability_labels` 正常输出(带 band/confidence)。

## Phase 5 — 读取侧与产品接入 🔄

- ✅ **解读框架 + applier 闭环(双层·多范围,离线验通)**:`t0_thresholds.py`(24 官方指标)+ `build_framework.py`(→ `framework.json`:**T0 官方层** 24指标/8规则 + **T2 自算层** 120阈值行[career/自然年/最近20·50·100]/4规则 + 档位/置信文案)+ `applier.py`(**范围 × 来源矩阵**:官方层 + 自算层同级并排,自算层多范围横排,各带档位/置信/同侪数,分层触发联动)。范围可用性不对称:赛区/赛季两源都有;最近N场、自然年为自算独有(官方显示—)。验证:小黑(14)T0 触发"人狼不统一",T2 多范围显示找狼近期下滑。app 详情页把实时按赛区 T0 + 逐场重建 T2 走同一逻辑。
- ✅ **步骤 4 桌面新 tab(前端)**:详情页「逐场战绩」后已加「特性画像」tab(桌面专属)。**T0 官方视图** + **T2 自算视图**均已上线。T0:`js/trait.js` 读 `V.model` 按赛区官方指标套 `/framework.json` 出档位+同侪排名+联动。T2:进 tab 即后台调 `/api/players/trait` 逐场重建(`player.ComputeGameFacts`+`analysis.Agg`,与 builder 同口径,7 选手交叉校验一致),按钮加载时置灰写明原因、就绪亮起→进入自算界面(联动+关键指标+样本置信),可返回官方页。顶部数据源截止日/算法概述/⚠测试中。framework.json 产出到 `internal/server/web/` 供 `embed.FS`。
- ⬜ (上次遗留)端到端抽查 `v_player_ability_labels` / `v_player_profile`(T2 深度层)。
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
- 2026-09-22:**Phase 3 深化研究(`research/deepen.py`,run 8)——沉淀发现:**
  - **普通狼(role='狼')后期推进**:普通狼熬到 D3+ 的狼队胜率 **72.7% vs 早死 60.9%(+11.9pt)**。**但含机械耦合**(赢的局本就更长、狼死得少),个体层面 普通狼D3+存活率×胜率 corr 仅 **0.265**——是"后期经营"的**弱**倾向信号,不能当强个人实力。类型:后期经营型(富贵雅雅/Hsy/董博 D3+~76%)vs 工具/牺牲型(小A D3+仅24%但胜率73%=冲锋弃子被带赢)。**结论**:可作弱标签,若上线需明确"含团队耦合、仅倾向"。未固化。
  - **胜率×场均分** corr **0.884**(强,高分基本就赢)。残差两端:团队兑现型(范特西大街 44%/1.80=靠队友)vs 个人carry不动(一颗星星 40%/2.84·205场、宝儿 54%/3.57=个人数据好但队伍没兑现)——验证 `g_team_cashin`/`g_personal_bonus` 规则成立。
  - 人狼一致性/被带赢已由 `cross_signals.py` 覆盖,不重复。
  - **警徽投对真预言家 × 对跳局胜负(验证 v5 警徽指标)**:对跳局好人整体胜率仅 29.8%(悍跳危险);但好人警下 **投对率越高、好人胜率单调越高**——[0,20%) 22.7% → [80,100%] 38.7%(+16pt),corr 0.146。说明 `badge_seer_hit_rate` 是**真实有效的读牌/协同信号**(注:含"真预言家有说服力→投对+获胜"的共因,仍有用)。
- 2026-09-21:**framework 固化进 Go + 规则/阈值解耦(用户定调"不要耦合")**——把解读框架拆成变化频率不同的两层:①**规则+文案+T0指标定义** = 手写的单一事实源 `internal/analysis/framework_rules.json`,Python 研究台(`build_framework.py`/`t0_thresholds.py`)与 Go 产品(`framework.go`)**共读同一份**;②**同侪阈值(十档)** = 从已建库分布算。改文案 = 只编辑该 JSON + 跑 `-framework`(秒级,不重建 13k 局);阈值重算 = `-rebuild`,不动文案。Go 产出 `internal/analysis/framework.json`(可提交的出厂产物,供桌面 embed),与 Python 版语义逐字段一致。**红利**:免 Python 出厂、免本地 MySQL、文案与阈值两条线彻底独立可迭代。
- 2026-09-21:**v5 第一天对决 + 警徽投票(用户定调,已固化 Go)**——①对跳"胜负"改为**只算第一天**(以熬过第一天为准、死因不限):真预言家胜=预言家熬过且悍跳全部第一天出局;悍跳胜=悍跳熬过且第一天有好人出局(含真预言家被票/毒或其他好人中假查杀);两人都活且无好人出局=平。替换旧的全场松口径,并**删除"真预言家清除率"**(含夜刀、非发言能力)。②警徽:数据无候选/上警字段、弃票未记录,故不做"上警率/弃票率",改用**投警徽率**(有竞选且活到竞选时真投了票的比例)当"爱上警"代理(低=常自己上警/弃票);警下投票去向(对跳局、排除对跳双方、只算真投了的)分**好人投对真预言家率**、**狼警徽冲锋率(投悍跳队友顶警徽)**、**狼警徽倒钩率(投真预言家装好人)**。③Go pooled 与 Python 原型 `duel_badge.py` 完全一致(44.9/37.3/53.6/56.9/39.8%)。algorithmVersion→t2-labels-v5,run 7。
- 2026-09-21:**联动文案规范(用户逐条敲定)**——所有规则 tag 统一 **事实（补充现象）** 结构。①**事实**先写指标高低(如"站对边率高但存活率低"),用同阵营五档相对位置;②**补充**只在能讲出数字之外的现象时才留(如"判断对、却常没能活到最后"/"自己早死、队伍常赢"),**纯复述指标名的补充一律删**("好人存活率高、狼人存活率低"后面不再跟"拿好人能活、拿狼易死");③**禁造总结词**(狼相重/潜伏倒钩型/抗推位/顺风躺赢…),只用真实狼人杀术语(倒钩/冲锋/悍跳/站对边/查杀/金水/刀神);④团队级归因写"**狼人集体**"(刀神/魅惑/恐惧对神);⑤技术写法改用户话(D3+→第三天起,标签与规则同步)。⑥官方层与自算层**分区展示,同名对比允许重复**,不去重。已按此重写 `build_framework.py` 全部 RULES + T2_RULES。存活率(含被刀)与被放逐(仅白天投票)口径不同,两条并存。
- 2026-09-21:**v4 指标接入 framework 层**——9 个 v4 指标(站对边/站对边被放逐/平民夜死/神职存活/梦魇·狼美人对神/真预言家清除/真预言家对跳胜/悍跳对跳胜)接进 `build_framework.py` 的 T2_LABEL + 新增 12 条 T2_RULES,`applier.py` HEAD 多范围表补站对边率/神职存活率/真预言家清除率。设计要点:①站对边率(zhanbian_rate)作独立"主线判断"轴,与 findwolf_rate 交叉出「抓点不跟线 / 跟线不抓点」;②对跳双胜(真预言家×悍跳)作跨阵营"发言硬"头条规则;③角色技能对神(梦魇/狼美人)标注"归团队"避免记个人。梦魇太罕见(24人 eligible<30)无阈值,规则恒不触发但保留。
- 2026-09-21:**按赛区画像的最终架构(用户提出,已验证)**——赛区是官方接口抓取参数,`player_stats`(T0)本就带 `zone_id/season_id` 且含 `toulang_pct/zhanbian_pct/cunhuo_pct/win_pct/hantiao_pct/molang_pct` 等**官方按赛区指标**。所以:①**离线只算分布阈值**(P10/30/70/90,建在**官方 T0 定义**上,`research/t0_thresholds.py`→`output/t0_thresholds.csv`);②详情页把 app **按赛区实时拉的 T0 值直接套阈值**出画像+联动。**不需要为赛区重爬**。红利:**站对边率=官方 zhanbian_pct,可上线版免做真预言家子工程**;赛区零成本。对齐铁律:阈值必须建在官方 T0 定义(官方好人存活率中位数 65% vs T2 的 ~40%,定义不同不可混)。T2 自算指标(合并找狼/above_field/联动/archetype)保留为深度研究层。可选精修:各赛区自己的基线只需轻量重爬 T0(每人每赛区一次 stats,不碰单局详情)。
- 2026-09-20:**可移植性模型**——一切派生结果确定性可复现。提交源(dump 走 LFS)+ 代码(Go builder、`research/` 脚本)+ 计划;**不**提交 MySQL 派生表与 `research/output/` 可再生产物,换机时按 `research/README.md` 重算。
- 2026-09-20:**round 2 复合强度结论**(`strength_v1.py`)——赛前强度加入找狼命中+存活后,单局胜负预测力**仍几乎为零**(Brier 0.2188,同 v0;预测区间 0.21–0.56)。单局被身份分配与临场随机主导。**决定**:团队难度残差**不作成色主信号**,成色以**个人局内执行(B)为核心**;对手强度/预计胜率仅作背景描述标签,禁止"赢下强敌⇒发挥好"。下一步:把 2e 个人执行(找狼相对全场、警徽、关键轮、暴露后存活)扩全并作为成色主轴,残差降级为 context。
- 2026-09-21:**产品形态重构(用户定调)**——真正要沉淀的是**解读框架**:①各指标"什么值=什么水平"的阈值(已有:`analysis_label_thresholds` 的 P10/30/70/90 按指标×阵营),②指标**联动规则**。App 是纯代理壳,后续拿**官方 API 实时数据**套进该框架来解读选手(不内嵌逐人标签库)。离线逐人结果**不一定做展示**,用户自用即可。选手页新 tab 展示**暂缓**(用户"再想想")。
- 2026-09-21:**翻译定稿**——分布五档:很高/偏高/中等/偏低/很低(相对同阵营位置);置信度四档(0-9/10-29/30-79/80+):样本极少/较少/适中/充足;找狼率两个指标(白天投票 vs 综合投票+技能)都展示。
- 2026-09-21:**联动规则(已验证,`interactions.py`)**——好人 findwolf × survival 基本不相关(corr −0.02,两独立轴);四象限胜率 强0.354>能找狼低存活0.338>好人缘好0.328>弱0.309(找狼比存活更影响胜率);放逐率 高找狼低存活组最高0.140(抗推位:判断对被投出)、好人缘好组最低0.115。两条用户假设成立,可作解读规则。
- 2026-09-21:**跨阵营/相关性挖掘 + 深挖(`cross_signals.py`/`cross_correlations.py`/`deep_dive.py`/`win_conditioned.py`/`skill_score.py`/`dimensions.py`/`slices.py`/`conditional.py`)——沉淀的解读规则:
  - **好人存活 vs 狼人存活 corr≈0**:人狼一致性只能实测不能推断;"只会当好人被带赢"(好活狼死,如老毛子/Sxy)与"拿狼更强"(李忆彤/嘉尔)是实测出的个体类型。
  - **胜利驱动**:好人赢靠找狼(+0.30)+MVP(+0.34),苟活(+0.12)/警长(+0.06)不直接赢;狼赢靠存活(+0.40)+MVP(+0.38),**悍跳≈0、自爆略负**(悍跳与胜率脱钩,条件分层后仍≈0)。
  - **胜局 vs 败局找狼**:全体 0.68 vs 0.49;败局仍高找狼=逆风carry(林杰/新仔),胜局也低找狼=躺赢(李元宝)。
  - **贡献型实力分**(找狼+MVP 的 z 合成):贡献解释部分胜率(好0.39/狼0.46),残差=躺赢(华仔仔)/被拖累(Rush/十万嬉皮)。
  - **牌感/存在感**是跨阵营特质:好找狼×狼被查杀 +0.24,两阵营都被预言家盯。
  - **PCA**:12 指标需 8 轴覆盖 80%(多维少冗余);PC1=拿狼强度、PC2=拿好人强度(与狼反向=人狼权衡轴)。
  - **身份决定存活**:预言家存活仅 0.076(必被刀),存活率必须按身份看;暴露后存活≈狼存活(r0.97,冗余)。
  - **趋势**:最近50 vs 生涯找狼率可标升降(第一浪+0.13 / Li−0.13)。
