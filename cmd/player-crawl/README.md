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

令牌三选一：环境变量 `HUASHAN_QUERY_TOKEN`、`-token`、`-token-file`。

```sh
HUASHAN_QUERY_TOKEN='粘贴你的令牌' \
go run ./cmd/player-crawl \
  -dsn 'root:你的密码@tcp(127.0.0.1:3306)/huashan?charset=utf8mb4&parseTime=true&loc=Local'
```

- 断点续爬：状态存在 `players.crawled`（0 待爬 / 1 完成 / 2 出错）。中断后**再跑一次同命令**即从未完成处继续。
- `-retry-errors`：把出错的选手重置为待爬再跑。
- `-seed`：自定义起始选手 ID（逗号分隔，默认内置 12 人名单）。
- `-workers`：并发拉详情数（1–16，默认 8）。
- `-max-games`：本次最多存多少局后停（默认 0=无限，首次全量可先设个数试跑）。

首次全量会拉很多局、耗时较长；对局详情定稿后不变，已存的完赛局再跑会跳过。

## 存了什么

| 表 | 内容 |
|---|---|
| `games` | 每局一行：日期/赛季/版型/胜负/天数/评选座位/状态 + 完整原始详情 `raw_json` |
| `game_players` | 每局每座一行：选手/门派/身份/悍跳天与身份/当选警徽天/自爆天 + `votes_json`/`skills_json` |
| `players` | 爬取队列与已发现选手，`crawled` 记状态 |

`raw_json` 是原始事实源（重建/训练都从它出）；`game_players` 是便于 SQL 直查的展开字段。

## 令牌怎么拿

用电脑版微信打开华山战力页登录后，令牌在本机内存/存储里；桌面版本身能读取。最简单：在桌面版里复制当前令牌，粘进 `HUASHAN_QUERY_TOKEN` 运行本工具。令牌会过期，报 401 就重新取一次再续跑。
