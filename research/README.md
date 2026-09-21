# Analysis research bench

Offline Python bench for prototyping and calibrating analysis metrics before the
deterministic formulas are hardened into the Go builder (`cmd/player-analysis-build`).
This code never ships in the desktop/web product (Go stdlib + native ES Modules only).
Plan and status: [`docs/player-analysis-roadmap.md`](../docs/player-analysis-roadmap.md).

## Bootstrap on a fresh machine

The whole pipeline is deterministic, so a new machine reproduces the exact analysis
state from source + code:

1. `git clone` the repo (Git LFS pulls `huashan-export.sql.gz`).
2. Start a local MySQL 8.4 server (see memory / roadmap Phase 0 for the portable-server
   commands) on `127.0.0.1:3306`, root, no password.
3. Import the dump: `gunzip -c huashan-export.sql.gz | mysql -h127.0.0.1 -u root`.
4. Rebuild derived tables: `go run ./cmd/player-analysis-build -rebuild`.
5. Install bench deps: `pip install -r research/requirements.txt`.
6. Verify: `cd research && python sanity_check.py`.

Override the DB target with `HUASHAN_DSN` (a SQLAlchemy URL) if not using the default.

## 自己看选手画像（无需经过 agent）

前提：本地 MySQL 在跑、已 `-rebuild`、装了 `research/requirements.txt`。然后：

```sh
cd research
python build_framework.py         # 生成/更新 output/framework.json（阈值+联动规则）
python applier.py 林杰             # 按名字看画像（也可用 ID：python applier.py 748）
```

> Windows 控制台默认 GBK 时 applier 会因 ▸ 等字符报 `UnicodeEncodeError`。前面加环境变量即可：
> `PYTHONIOENCODING=utf-8 PYTHONUTF8=1 python applier.py 林杰`。

输出是「范围 × 来源」矩阵：官方 T0 层（各项档位/置信）+ 自算 T2 层（生涯/最近50/最近20/自然年多范围）+ 分层联动解读。名字支持模糊匹配，多个同名会列出让你挑 ID。

其它可直接跑的分析脚本：`deep_dive.py`（选手聚类+胜利驱动）、`cross_correlations.py`（指标相关性挖联动）、`interactions.py`（找狼×存活四象限）、`t0_thresholds.py`（各官方指标水平线）。

## What is and isn't committed

- **Committed:** these scripts, `requirements.txt`, and the source dump (via LFS).
- **Not committed (regenerate):** the MySQL `analysis_*` tables and everything under
  `research/output/` (caches, plots, model files). Reproduce them by re-running the
  builder and scripts — never hand-edit derived state.
