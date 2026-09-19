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

- 断点续爬：状态存在 `players.crawled`（0 待爬 / 1 完成 / 2 出错）。中断后**再跑一次同命令**会先接着未完成选手继续；如果上一轮已经跑完，新的启动会自动重查所有已发现选手的对局列表，用来发现新增对局和新增关联选手。
- 当前进度：`crawl_state` 记录当前阶段、当前选手和当前牌局，可随时 `SELECT * FROM crawl_state;` 查看。
- `-retry-errors`：把出错的选手重置为待爬再跑。
- `-seed`：自定义起始选手 ID（逗号分隔，默认内置 12 人名单）。
- `-workers`：并发拉详情数（1–16，默认 1）。要精确记录“当前正在拉哪一局”并尽量温和访问官方接口，建议保持 1。
- `-request-interval`：全局最小请求间隔（默认 `2s`）。无论列表还是详情，请求都会按这个节奏发出。
- `-wait-token`：遇到 401 时不退出，而是停在当前选手/牌局等待新 token（默认开启）。
- `-token-poll-interval`：等待新 token 时的轮询间隔（默认 `30s`）。
- `-token-max-age-days`：扫描本机微信候选 token 的最大文件年龄（默认 3；`0` 表示不限）。
- `-max-games`：本次最多存多少局后停（默认 0=无限，首次全量可先设个数试跑）。

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
| `games` | 每局一行：日期/赛季/版型/胜负/天数/评选座位/状态 + 完整原始详情 `raw_json` |
| `game_players` | 每局每座一行：选手/门派/身份/悍跳天与身份/当选警徽天/自爆天 + `votes_json`/`skills_json` |
| `players` | 爬取队列与已发现选手，`crawled` 记状态 |

`raw_json` 是原始事实源（重建/训练都从它出）；`game_players` 是便于 SQL 直查的展开字段。

## 令牌怎么拿

用电脑版微信打开华山战力页登录后，令牌在本机内存/存储里；桌面版本身能读取。最稳妥的做法是把当前 token 写进 `-token-file` 指向的文件，长期跑的时候只更新这个文件。令牌会过期；现在程序会在 401 时停在当前进度等待新 token，文件更新后自动续跑。
