---
name: refresh-analysis
description: 华山战力查询仓库的「画像数据刷新流水线」——从华山官方接口增量抓取最新对局与选手汇总，重建本地分析库，产出并嵌入桌面版出厂框架 framework.json。凡是要刷新选手画像数据、更新特性画像的阈值/分布/档位/排名、重跑分析构建器、核对 Go 与 Python 两侧口径是否一致、排查画像数值不对或阈值过期或联动规则不触发、或觉得爬虫太慢/抓了太多没必要的请求，都要用这个 skill；即使用户只说「拉最新数据」「更新一下数据」「重算画像」「更新 framework」「跑一下 builder」「数据落后了」也要用。涉及修改画像显示文案（指标标签、联动解读、档位说明、样本提示）时同样适用，因为它规定了文案线与阈值线如何解耦——这是最容易走错的地方。
---

# 画像数据刷新流水线

把「官方接口 → 本地 MySQL → 分析事实 → 出厂 framework.json → 桌面版 embed」这条链跑通。
每一步都可独立重跑，且**生成是确定性的**（同一份库连跑两次，产物字节一致）。

## 动手前先确认这三件事

走错了会白跑几小时、改错文件，或者把令牌预算浪费在没变化的数据上。

### 一、出厂重算是 Go，不是 Python

产品里嵌的 `internal/server/web/framework.json` 由 `cmd/player-analysis-build`（Go）产出。
`research/*.py` 是**研究台**：`t0_thresholds.py`/`build_framework.py`/`applier.py` 是 Go 的孪生实现（用于交叉校验），其余约 26 个脚本是研究原型（产出 CSV 供决策，gitignore，不出厂）。原则是 **Python=research, Go=ship**。

想让软件里的数字变化，跑 Go；跑 Python 不影响产品。

### 二、文案不由数据生成

指标标签、联动解读、档位说明全部手写在单一事实源 `internal/analysis/framework_rules.json`。
Go 和 Python **都只读它**，谁都不生成措辞。

| 你要改什么 | 改哪里 | 跑什么 | 耗时 |
|---|---|---|---|
| 文案（标签/联动/档位词） | `framework_rules.json` | `-framework` | 秒级，**不重建库** |
| 阈值（分位/baseline/n） | 不用改文件，数据变了自动重算 | 增量或 `-rebuild` | 分钟级 |

不存在「拉了新数据所以文案自动更新」——刷新数据只改阈值/分布/baseline/n，一个字的措辞都不会变。

### 三、先算令牌预算，再决定跑什么

华山 Token 是 **24 小时有效期的 JWT**，`exp` 字段是硬截止。抓取速率被 `-request-interval` 全局节流（**默认 100ms ≈ 10 req/s**），所以：

```
可用请求数 ≈ 令牌剩余秒数 × 10
```

从 JWT payload 解 `exp` 算剩余时间（不要猜）。预算不够时按下面的优先级取舍，**不要两个爬虫同时跑**——它们是各自独立节流的，同时开等于对上游双倍压力。

上游保护已经内建，所以 100ms 是安全的：`internal/huashan` 有 `upstreamConc = 16` 全局并发上限，且 429/5xx 会按 `gamesRetryBackoff`（300ms/900ms）自动退避重试最多 3 次，重试仍失败则跳过该页并标 `trunc`，不会整轮崩。**如果日志里持续出现退避或 `trunc`，把 `-request-interval` 调大**（这是唯一的回退手段，别去改并发上限）。

## 前置条件

**本地 MySQL**（无系统服务，便携版）：
- 服务端 `F:/mysql-local/mysql-8.4.11-winx64`，库 `huashan`，`root` 无密码，`127.0.0.1:3306`
- 客户端 `F:/mysql-local/mysql-8.4.11-winx64/bin/mysql.exe`
- 换机器按 `research/README.md` 的 Bootstrap：导入 `huashan-export.sql.gz`（Git LFS）后 `-rebuild`

**华山登录 Token**——只有阶段 1/2 需要，阶段 3 之后全程离线。
来源优先级：`-token` > `-token-file` > 环境变量 `HUASHAN_QUERY_TOKEN` > 扫本机微信目录（`-token-max-age-days` 默认 3）。

令牌安全：
- 写到**仓库外**再用 `-token-file` 引用，例如 `umask 077 && cat > "$USERPROFILE/.huashan-token"`；**绝不写进仓库**（会被 commit）
- 跑完删掉令牌文件
- `.claude/settings.json` 已 deny 读取 `deploy-token.txt` / `deploy-url.txt`（那是 Gitee 发布令牌，与华山无关）

本机微信路径是 `AppData/Roaming/Tencent/xwechat` 与 `AppData/Roaming/Tencent/WeChat`（不是 `Documents/WeChat Files`），见 `internal/wechat/wechat.go` 的 `windowsRoots`。探测令牌来源时别查错目录。

> **令牌缺失/过期时的陷阱**：两个爬虫的 `-wait-token` 默认为 **true**，此时**不会报错退出，而是无限轮询等新令牌**。
> 无人值守的长任务一律加 `-wait-token=false`，让它到点干净退出。
> 启动前必须显式确认令牌可用，否则会以为在跑、其实挂住了。

## 阶段 0：看现状 + 算预算（不需要令牌）

```sh
go run ./cmd/player-analysis-build -status
```

给出最新 run 的完成时间、`algorithmVersion`、覆盖率（source / analyzed / reconstructed / failed / doubts）和派生行数。
再查库判断该抓什么：

```sql
SELECT COUNT(*) games, MAX(play_date) latest FROM games;
SELECT DATE(fetched_at) d, COUNT(*) n FROM player_stats GROUP BY d ORDER BY d DESC LIMIT 5;
```

`MAX(play_date)` 与今天的差 = 逐场数据落后多久；`fetched_at` 分布 = 汇总快照的新旧混杂程度。

## 阶段 1：抓逐场详情 → `games` / `game_players`

**先跑这个**：新对局才是真正的新信息（T2 自算指标全靠它），而且它会**发现新选手**——`player_stats_crawl_state` 的 `waiting_players` 状态就是在等它。

```sh
go run ./cmd/player-crawl -token-file ~/.huashan-token -workers=8 -wait-token=false
go run ./cmd/player-crawl -max-games=50          # 只验链路是否通
go run ./cmd/player-crawl -migrate               # 离线回填 roster 标记，不需要令牌
```

`-request-interval` 默认 **100ms**，不用再显式传。`-workers` 只影响延迟隐藏，全局速率由 interval 封顶。

**负缓存**：有些局 ID 出现在选手的局列表里，但详情已被上游下架，永远返回 404。这些 ID 从不落库，所以「已存局跳过」的续跑判断抓不到它们，导致每轮重复请求。现在失败结果记在 `game_fetch_failures`，启动时载入并跳过：

```
skipping: 317 game(s) upstream no longer serves (-retry-dead to override)
```

- 404/410 一次即判定永久；其他错误累计到 `deadAttemptLimit`(5) 次才判永久，避免一次网络抖动拉黑好局
- `context.Canceled` / `DeadlineExceeded` **不记录**——那是我们放弃，不是上游没有
- 判定走类型化的 `*huashan.APIError.Status`，**不要匹配中文错误消息**（`找不到某些请求的实体` 是本地化文案，会变）
- 缓存自我填充：首轮边跑边记，之后各轮跳过。`-retry-dead` 可强制重试

> **不要去做「按 play_date 水位线提前停止翻页」这个优化——已量化否决。**
> 直觉上 `loadPlayerGames` 每轮重走 4794 人的局列表像是主开销，但实测：`gamesPerPage=100` 而选手平均只有 34.7 局（最多 510），**91.7%（4394 人）本来就只需 1 页**；全量走一遍共 **5287 个翻页请求**，水位线最多省 **493 个（9.3%）**，@100ms 约 **50 秒**。而且第 2..N 页是 `gamesWorkers=8` 并发拉的，墙钟成本比请求数更低。
> 代价却不成比例：要改 `internal/huashan` 这个桌面版也在用的共享接口；要依赖「列表严格新→旧」这个**无法离线验证**的假设（上游改排序、或某局 `play_date` 被事后修正，就是静默漏抓）；还要让 `player_game_result_state.complete` 区分「主动提前停」与「不完整」。
> 真正解决问题的是 `-request-interval` 从 2s 改到 100ms：全量走一遍从 **~3.2 小时降到 ~9 分钟**。觉得慢先调 interval，别动翻页逻辑。
>
> 同理**不要**用「选手汇总没变就跳过走列表」来省请求：那会与阶段 2 形成循环依赖（汇总要靠新局才知道谁变了，新局要靠走列表才能发现）。而且两边都只要 ~8 分钟，串起来反而更慢。

**进度判据**：别看日志行数——大量 404 是正常现象。看库：

```sql
SELECT COUNT(*) games, MAX(play_date) latest FROM games;
SELECT permanent, COUNT(*) FROM game_fetch_failures GROUP BY permanent;
```

## 阶段 2：抓官方 T0 汇总 → `player_stats`

```sh
go run ./cmd/player-stats-crawl -token-file ~/.huashan-token \
  -follow-players=false -wait-token=false -workers=4
```

**默认增量**。官方 T0 是**生涯累计汇总**，选手的数字只在他真的打了新局时才会变，所以只重抓「最新一局日期 ≥ 快照日期」的选手。实测：**4772 人 → 158 人**；配合 100ms 间隔，一轮从 2.66 小时降到**约 20 秒**。

实现要点（改这里前先读懂）：
- `last_played` 来自**派生表**（`MAX(g.play_date)` 每人只算一次）。写成相关子查询 `EXISTS` 会对每个候选行重扫该选手的局列表，在 165k 行的 `game_players` 上每批要几秒——`TestStatsFromClauseUsesDerivedTable` 就是钉住这一点
- 比较用 `>=` 而不是 `>`，保证同日竞态安全：快照之后才结束的局仍会触发重抓
- `-full` 恢复旧的全量扫描，用于上游**没有新局却改了历史**的情况（补记违规扣分、纠正评选）
- `-max-age=720h` 之类加一层陈旧兜底：长期没上场的选手、以及局从没被抓过的选手（`last_played` 为 NULL，增量条件永远不成立）也会被刷新
- `-follow-players` 默认 true 会**永不退出**，跑一轮就收工必须显式 `=false`
- `-retry-errors` 重抓上次 `fetch_status='error'` 的选手

跑完应看到 `0 pending` 并自行退出；`SELECT COUNT(*) FROM player_stats WHERE DATE(fetched_at)=CURDATE()` 等于本轮刷新数。

## 阶段 3：重建分析库 + 出厂 framework.json

```sh
go run ./cmd/player-analysis-build              # 增量刷新变更局，并顺带产出 framework.json
go run ./cmd/player-analysis-build -rebuild     # 全量重建每个确定性事实
go run ./cmd/player-analysis-build -framework   # 只重算出厂产物，完全不动库
```

- 默认模式先判断源数据有没有变；没变就只重算 aggregates 和 labels，开一个新 run 号。实测约 **7 分钟**
- 出厂路径 `-framework-out`，默认 `internal/server/web/framework.json`（`embed.FS` 嵌入桌面版）
- 文案路径 `-rules`，默认 `internal/analysis/framework_rules.json`
- **只改文案时永远用 `-framework`**，别 `-rebuild`——后者白等几分钟且毫无必要

跑完核对计数，例如 `framework.json: T0 26指标 + 26规则; T2 254阈值行 + 34规则`。

## 阶段 4：交叉校验（可选；改了口径就要跑）

```sh
cd research                                                  # 必须 cd，脚本用相对路径 output/framework.json
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python build_framework.py
PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python applier.py 林杰    # 也可用 ID：applier.py 748
```

两个坑：**必须 `cd research`**（否则 `FileNotFoundError: output/framework.json`）；**必须带 UTF-8 环境变量**（Windows 控制台默认 GBK，`▸` 会触发 `UnicodeEncodeError`）。

校验标准：Go 与 Python 的 T0/T2 指标数、阈值行数、规则数逐项一致，`t0_rules`/`t2_rules` 的 JSON 完全相同。Go 产物多 `source_games` / `source_max_date` 两个字段（页面顶部显示数据截止日），Python 侧没有，属预期差异。

## 阶段 5：收尾义务（来自 AGENTS.md，别漏）

1. **程序内帮助**：功能入口、筛选排序、计算口径、加载状态或功能限制变化时，同步 `internal/server/web/js/options.js` 的「使用说明」与「FAQ」。使用说明讲怎么操作，FAQ 讲行为原因与边界。
2. **术语表**：显示文案须符合 `docs/standards/werewolf-language.md`。新增身份、版型或规则时**先补术语表再写文案**。同一概念在界面、帮助、更新说明和测试断言里用同一个名称。
3. **用户文案规范**：描述用户看到的现象、得到的结果和能采取的操作；日志用英文，界面文案用中文；避免「口径」「收缩」「参照分布」这类行话。
4. **CHANGELOG.md**：以用户能感知的变化为收录标准，每条一句简短完整的用户语言，写在 `## [未发布]` 下。已发布版本的历史条目不要改。
5. **docs/player-analysis-roadmap.md**：在「决策记录」按日期追加，写清结论、数据和剪枝理由。
6. **爬虫自己的 README**：`cmd/player-crawl/README.md`、`cmd/player-stats-crawl/README.md` 是旗标与行为的事实源，改了旗标要同步。
7. **Git**：功能分支开发；合入 `main` 前先 rebase；`main` 用 `git merge --ff-only <branch>` 保持线性历史。

## 验证（不需要令牌，随时可跑）

```sh
go build ./... && go vet ./cmd/... && go test ./cmd/... ./internal/...
node --check internal/server/web/js/trait.js
go run ./cmd/player-analysis-build -status
```

改过前端 JS 一律 `node --check`；改过 Go 一律 build + vet + test。
**注意 Bash 工具默认 120 秒超时**：跑构建器（约 7 分钟）或等待爬虫时，必须显式传更长的 timeout，或用 `nohup ... &` 放后台再轮询日志。

## 边界情况

**某指标凑不满 30 人 → 规则自动休眠，这是设计不是 bug。**
`frameworkT2` 对不足 30 人的分组不产出分布行，于是前端 `bands[]` 取不到该键、规则不触发，表格 `rowMetrics()` 也不列该行。数据攒够后 `frameworkT2` 自动补出行，前端无需改动即自动显示并参与联动。
**不要因为它不显示就把规则或标签删掉。** 当前 `nightmare_god_rate`（梦魇恐惧对神率）就是这种休眠状态。

**`roster_ok=0` 的局被排除。** 官方 payload 名单损坏（同一 player_id 占多座位）的局，构建器排除并记 `parse_error`，当前 52 局。仍进 T1 计数，不进自算指标。

**`doubts` 不是错误。** 当前 1078，是重建过程的近似标记（怪盗狼王技能态免疫、狼王带人、投票与死亡序列冲突等），属预期披露项。

**覆盖率要报出来。** 重建失败的局不进自算指标；覆盖不全时按阵营、身份、胜负和年代分层报告缺口。

## 排错速查

| 症状 | 原因 | 处理 |
|---|---|---|
| 爬虫启动后无输出也不退出 | `-wait-token` 默认 true，在等令牌 | 确认令牌可用；无人值守加 `-wait-token=false` |
| 爬虫跑完不退出 | `-follow-players` 默认 true | 加 `-follow-players=false` |
| 抓了 4772 人却只有 3 局新数据 | 用了 `-full`，或误以为汇总能按日期过滤 | 去掉 `-full`；T0 是生涯累计，只能按「有没有新局」增量 |
| 日志持续出现退避 / 列表被标 `trunc` | 100ms 对上游太快，被限流了 | 调大 `-request-interval`（如 `500ms`、`2s`）；客户端本身已对 429/5xx 退避重试 3 次 |
| 日志刷满「找不到某些请求的实体」 | 上游已下架的局，正常现象 | 看 `game_fetch_failures` 是否在增长；持续重试才用 `-retry-dead` 排查 |
| 想重新验证某个死局 | 负缓存跳过 | `-retry-dead`，或删 `game_fetch_failures` 对应行 |
| Python 侧 `FileNotFoundError: output/framework.json` | 没 `cd research` | 必须在 `research/` 下跑 |
| Python 侧 `UnicodeEncodeError` | Windows 控制台 GBK | 前缀 `PYTHONIOENCODING=utf-8 PYTHONUTF8=1` |
| 改了文案但软件里没变 | 没重生成出厂产物 | 跑 `-framework` |
| 改文案却顺手 `-rebuild` 等了几分钟 | 混淆文案线与阈值线 | 文案只需 `-framework`（秒级） |
| 规则数与源不一致 | 规则 `when` 引用了不存在的指标标签 | 校对 `framework_rules.json` 的 `when` 标签是否在 `t0_metric_defs` 中 |
| 构建器连不上库 | 便携版 MySQL 没起 | 启 `F:/mysql-local/mysql-8.4.11-winx64/bin/mysqld.exe`，`netstat -an \| grep 3306` 确认 |
| 后台命令 2 分钟就被打断 | Bash 工具默认 timeout 120s | 显式传 timeout，或 `nohup &` 后轮询日志 |
