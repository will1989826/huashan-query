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

- **增量重刷**：只重抓「最新一局日期 ≥ 上次快照日期」的选手。官方 T0 是生涯累计汇总，选手的数字只在他真的打了新局时才会变，所以没必要每轮扫全员。实测一轮从 4772 人降到 158 人、2.66 小时降到约 2 分钟
- 从未抓过的选手始终纳入
- 并发 2 个选手面板请求
- 全局最小请求间隔 `100ms`
- 遇到 401 时停下等待新 token
- 当已发现选手都抓完后，不退出，而是继续轮询 `players` 表，等 `player-crawl` 发现新选手后继续补抓

比较用的是 `>=` 而不是 `>`，保证同日竞态安全：快照之后才结束的局仍会触发重抓。

## 增量与全量

增量判据来自派生表 `MAX(games.play_date)`（每人只算一次；写成相关子查询会对每个候选行重扫该选手的局列表，在 165k 行的 `game_players` 上每批要几秒）。

两种情况需要绕过增量：

- `-full`：上游**没有新局却改了历史**——补记违规扣分、纠正评选结果。恢复旧的「作用域内全员重刷」行为
- `-max-age=720h`：陈旧兜底。长期没上场的选手、以及局从没被 `player-crawl` 抓过的选手（`last_played` 为 NULL，增量条件永远不成立）也会被刷新。默认 `0` 表示关闭

`-retry-errors` 在增量模式下是独立分支：既抓有新局的，也抓上次 `fetch_status='error'` 的。

## 重要参数

- `-zone`：作用域赛区，默认 `ALL`
- `-season`：可选赛季 ID；默认空表示不限赛季
- `-workers`：并发请求数（1–16，默认 2）
- `-request-interval`：全局最小请求间隔（默认 `100ms`）。官方接口返回 429/5xx 时客户端会自动退避重试，偶发限流无需人工干预；持续被限流就把这个值调大
- `-request-timeout`：单个选手统计请求超时（默认 `45s`）
- `-wait-token`：401 时等待新 token（默认开启）
- `-token-poll-interval`：等待新 token 时的轮询间隔（默认 `30s`）
- `-follow-players`：当前库里暂时抓完后继续轮询新发现选手（默认开启）
- `-idle-poll-interval`：等待新选手时多久重查一次（默认 `1m`）
- `-retry-errors`：重试本次启动前 `fetch_status='error'` 的选手，每名选手在一次运行中最多重试一次
- `-full`：忽略增量判据，重刷作用域内全部选手（上游改了历史但没产生新局时用）
- `-max-age`：额外把快照早于此时长的选手纳入重刷，即使他没有新局（默认 `0`=关闭）

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
