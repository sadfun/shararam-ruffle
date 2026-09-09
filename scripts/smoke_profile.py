#!/usr/bin/env python3
"""Prints what a profile file contains — used by CI right after a short
smoke run of the profiler exe, and handy for a quick look at any profile.

    python scripts/smoke_profile.py profiles/shararam-profile-….duckdb
"""
import sys

import duckdb

path = sys.argv[1]
db = duckdb.connect(path, read_only=True)
print("meta:")
for key, value in db.sql("select key, value from meta order by key").fetchall():
    print(f"  {key} = {value[:80]}")
print("rows:", {t: db.sql(f"select count(*) from {t}").fetchone()[0]
                for t in ["events", "frames", "samples", "snapshots", "loads", "rtmp"]})
print("samples by name:")
for name, n, lo, hi in db.sql(
    "select name, count(*), round(min(value),1), round(max(value),1) from samples group by 1 order by 1"
).fetchall():
    print(f"  {name:22s} n={n:<6d} min={lo} max={hi}")
print("events by source/cat/name (top 40):")
for source, cat, name, n in db.sql(
    "select source, cat, name, count(*) from events group by 1,2,3 order by 4 desc limit 40"
).fetchall():
    print(f"  {source:8s} {cat:10s} {name:22s} {n}")
for row in db.sql("select left(args, 600) from events where cat='native' order by ts_us limit 3").fetchall():
    print("native sample:", row[0])
