# player-stats-crawl

把官方“选手个人统计面板”批量写入本地 MySQL，供 SQL 直接查询站边率、生存率、胜率、警长次数等官方汇总字段。

这个工具**不靠自增 `player_id` 盲扫**；默认从 `player-crawl` 已发现的 `players` 表读取选手，再调用官方统计接口补齐个人面板。这样更稳，因为官方统计接口对不存在的 `player_id` 不一定稳定返回“未找到”。

## 前置

- Go 1.24+
- 本机 MySQL 8+
- 已经有 `player-crawl` 在持续发现选手，至少建好了 `huashan` 库和 `players` 表
- 令牌推荐放进固定文件，例如 `/Volumes/MOVESPEED/mysql/huashan.token`

## 运行

```sh
go run ./cmd/player-stats-crawl \
  -token-file /Volumes/MOVESPEED/mysql/huashan.token \
  -dsn 'root:你的密码@tcp(127.0.0.1:3306)/huashan?charset=utf8mb4&parseTime=true&loc=Local'
```

默认行为：

- 每次启动都会重刷当前作用域下已发现选手的官方统计面板，确保新对局产生后的汇总字段也会更新
- 并发 2 个选手面板请求
- 全局最小请求间隔 `2s`
- 遇到 401 时停下等待新 token
- 当已发现选手都抓完后，不退出，而是继续轮询 `players` 表，等 `player-crawl` 发现新选手后继续补抓

## 重要参数

- `-zone`：作用域赛区，默认 `ALL`
- `-season`：可选赛季 ID；默认空表示不限赛季
- `-workers`：并发请求数（1–16，默认 2）
- `-request-interval`：全局最小请求间隔（默认 `2s`）
- `-request-timeout`：单个选手统计请求超时（默认 `45s`）
- `-wait-token`：401 时等待新 token（默认开启）
- `-token-poll-interval`：等待新 token 时的轮询间隔（默认 `30s`）
- `-follow-players`：当前库里暂时抓完后继续轮询新发现选手（默认开启）
- `-idle-poll-interval`：等待新选手时多久重查一次（默认 `1m`）
- `-retry-errors`：重试之前 `fetch_status='error'` 的选手

## 看进度

当前进度在 `player_stats_crawl_state`：

```sql
SELECT * FROM player_stats_crawl_state;
```

统计结果在 `player_stats`，一名选手每个作用域一行：

```sql
SELECT player_id, player_name, fetch_status, fetched_at
FROM player_stats
WHERE zone_id = 'ALL' AND season_id = 0
ORDER BY fetched_at DESC
LIMIT 20;
```

## 怎么看官方站边率

官方综合、好人、狼人三组原始面板分别存在：

- `summary_json`
- `haoren_json`
- `langren_json`

例如直接看好人站边字段：

```sql
SELECT
  player_id,
  player_name,
  JSON_EXTRACT(haoren_json, '$.zhanbian_pct')   AS zhanbian_pct,
  JSON_EXTRACT(haoren_json, '$.zhanbian_snum')  AS zhanbian_snum,
  JSON_EXTRACT(haoren_json, '$.zhanbian_total') AS zhanbian_total
FROM player_stats
WHERE zone_id = 'ALL' AND season_id = 0 AND fetch_status = 'ok'
ORDER BY CAST(JSON_UNQUOTE(JSON_EXTRACT(haoren_json, '$.zhanbian_pct')) AS DECIMAL(10,2)) DESC
LIMIT 50;
```

类似地：

- 综合字段看 `summary_json`
- 狼人字段看 `langren_json`
- 战力看 `power_json`

## token 过期

推荐一直使用 `-token-file`。令牌过期后：

1. 程序会停在当前选手并把状态写进 `player_stats_crawl_state`
2. 你把新的 token 覆盖写回同一个文件
3. 程序轮询到有效 token 后自动继续
