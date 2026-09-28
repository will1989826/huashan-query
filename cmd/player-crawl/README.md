# player-crawl

从种子选手出发，沿"选手 ↔ 对局"图 BFS 爬取全部可达的对局详情，直写本地 MySQL，供离线分析与训练。令牌只用于请求、**绝不写入数据库**。

## 前置

- Go 1.24+、MySQL 8+（本机）。
- 建库（utf8mb4，存中文名/门派名）：

  ```sql
  CREATE DATABASE huashan CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  ```

- 装 MySQL 驱动（会给 `go.mod`/`go.sum` 加这一个依赖，仅本工具用，不进桌面版运行时）：

  ```sh
  go get github.com/go-sql-driver/mysql
  ```

建表由程序启动时自动执行（`schema.sql` 是唯一事实源，也可手动 `mysql huashan < cmd/player-crawl/schema.sql`）。

## 运行

令牌三选一：环境变量 `HUASHAN_QUERY_TOKEN`、`-token`、`-token-file`。**长期全量爬取建议用 `-token-file`**，这样令牌过期后只要覆盖写入新 token，程序就能自动继续。

```sh
go run ./cmd/player-crawl \
  -token-file /path/to/huashan.token \
  -dsn 'root:你的密码@tcp(127.0.0.1:3306)/huashan?charset=utf8mb4&parseTime=true&loc=Local'
```

- 断点续爬：状态存在 `players.crawled`（0 待爬 / 1 完成 / 2 出错）。中断后**再跑一次同命令**会先接着未完成选手继续；如果上一轮已经跑完，新的启动会自动重查所有已成功处理的选手，用来发现新增对局和新增关联选手。
- 当前进度：`crawl_state` 记录当前阶段、当前选手和当前牌局，可随时 `SELECT * FROM crawl_state;` 查看。
- `-retry-errors`：把本次启动前出错的选手纳入队列，每名选手在一次运行中最多重试一次。
- `-seed`：自定义起始选手 ID（逗号分隔，默认内置 12 人名单）。
- `-workers`：并发拉详情数（1–16，默认 1）。要精确记录“当前正在拉哪一局”并尽量温和访问官方接口，建议保持 1。
- `-request-interval`：全局最小请求间隔（默认 `100ms`）。无论列表还是详情，请求都会按这个节奏发出。官方接口返回 429/5xx 时客户端会自动按 300ms/900ms 退避重试（单页最多 3 次），所以偶发限流不需要人工干预；**如果日志里持续出现退避或列表被标记 `trunc`，就把这个值调大**。
- `-retry-dead`：重新请求负缓存已判定为「上游不再有」的局（见下节）。
- `-wait-token`：遇到 401 时不退出，而是停在当前选手/牌局等待新 token（默认开启）。
- `-token-poll-interval`：等待新 token 时的轮询间隔（默认 `30s`）。
- `-token-max-age-days`：扫描本机微信候选 token 的最大文件年龄（默认 3；`0` 表示不限）。
- `-max-games`：本次最多存多少局后停（默认 0=无限，首次全量可先设个数试跑）。
- `-migrate`：只应用 schema 并**从已存 `raw_json` 重新计算名单质量标记**（`games.roster_ok`/`roster_issue`）后退出，不需要令牌、不发任何请求。导入旧 dump 或改了名单校验规则后跑一次即可。
- `-refresh-stored`：重新请求已存的终局详情，用于华山修订历史对局；仍会跳过永久负缓存，除非同时指定 `-retry-dead`。

## 死局负缓存

有些局 ID 出现在选手的局列表里，但详情已被上游下架，永远返回 404。这些 ID 从不落 `games` 表，所以「已存局跳过」的续爬判断抓不到它们——**每一轮都会把全部死局重新请求一遍**（实测约 590 个 ID、20 分钟白跑，且随上游继续下架而增长）。

失败结果记在 `game_fetch_failures`，启动时载入并跳过：

```
skipping: 1043 game(s) upstream no longer serves (-retry-dead to override)
```

判定规则：

- **404 / 410 一次即判永久**——上游明确说没有这个局，不会自己回来
- **其他错误只保留失败记录，不会判永久**——限流、网络波动和上游 5xx 会在下次运行重试，不能把健康对局拉黑
- **`context.Canceled` / `DeadlineExceeded` 完全不记录**——那代表我们放弃（Ctrl-C、单局超时），不代表上游没有这个局
- 判定走类型化的 `*huashan.APIError.Status`，**不匹配中文错误消息**（`找不到某些请求的实体` 是本地化文案，会随系统语言变化）

缓存是自我修复的：首轮边跑边记，之后只跳过 404 / 410；`-retry-dead` 成功抓回后会自动清除对应失败记录。

```sql
SELECT permanent, COUNT(*) n, MAX(attempts) mx FROM game_fetch_failures GROUP BY permanent;
-- 想让某个局重新被尝试：
DELETE FROM game_fetch_failures WHERE game_id = ?;
```

## 名单质量

一局有效对局应是 **12 座、各座一个不同的正整数 player_id**。官方数据偶尔把同一选手放到多个座位，或用 npc/空位（`player_id<=0`）填充；这类名单无法按选手归属，会在玩家级聚合里**把该局重复计数**。存局时程序会校验并标注：

- `roster_ok=1`：名单正常。
- `roster_ok=0` + `roster_issue`：`duplicate_player_seats`（一个 player_id 占多座）/ `missing_player_seat`（有座位缺选手）/ `incomplete_roster`（不足 12 座）。

原始局仍照常保存（`raw_json` 是事实源），但分析构建器会排除 `roster_ok=0` 的局并在覆盖率里单列。

首次全量会拉很多局、耗时较长；后续再次启动时会重新检查所有已发现选手的对局列表，但**已存的完赛局详情仍会跳过**，只补新发现的对局和新关联到的选手。默认配置就是“慢速长跑”模式，适合整库持续补齐。

## 慢速全量推荐

```sh
go run ./cmd/player-crawl \
  -token-file /Volumes/MOVESPEED/mysql/huashan.token \
  -dsn 'root:你的密码@tcp(127.0.0.1:3306)/huashan?charset=utf8mb4&parseTime=true&loc=Local' \
  -workers 1 \
  -request-interval 2s \
  -wait-token=true
```

遇到 token 过期时：

1. 程序会把当前位置写进 `crawl_state`。
2. 终端会提示正在等待新 token。
3. 你只需要把新的 token 覆盖写入同一个 `-token-file`。
4. 程序下一次轮询到有效 token 后会自动继续，不需要重启。

## 存了什么

| 表 | 内容 |
|---|---|
| `games` | 每局一行：日期/赛季/版型/胜负/天数/评选座位/状态 + 名单质量标记 `roster_ok`/`roster_issue` + 完整原始详情 `raw_json` |
| `game_players` | 每局每座一行：选手/门派/身份/悍跳天与身份/当选警徽天/自爆天 + `votes_json`/`skills_json` |
| `player_game_results` | 逐场接口中的选手得分、胜负、MVP、尽力、背锅和完整原始行，供 T1 分析复算 |
| `player_game_result_state` | 每名选手逐场列表的抓取行数、异常行数和完整性 |
| `players` | 爬取队列与已发现选手，`crawled` 记状态 |

`raw_json` 是原始事实源（重建/训练都从它出）；`game_players` 是便于 SQL 直查的展开字段。

## 令牌怎么拿

用电脑版微信打开华山战力页登录后，令牌在本机内存/存储里；桌面版本身能读取。最稳妥的做法是把当前 token 写进 `-token-file` 指向的文件，长期跑的时候只更新这个文件。令牌会过期；现在程序会在 401 时停在当前进度等待新 token，文件更新后自动续跑。
