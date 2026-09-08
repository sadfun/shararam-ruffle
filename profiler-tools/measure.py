import duckdb, sys, os
f = sys.argv[1]; skip = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
con = duckdb.connect(f, read_only=True)
t0 = con.execute("SELECT min(ts_us) FROM events WHERE name='tick'").fetchone()[0]
vp = con.execute("SELECT args FROM events WHERE name='viewport' ORDER BY ts_us DESC LIMIT 1").fetchone()[0]
r = con.execute(f"""
SELECT
  count(CASE WHEN name='tick' THEN 1 END) / ((max(ts_us)-min(ts_us))/1e6),
  avg(CASE WHEN name='submit' THEN dur_us END)/1000,
  avg(CASE WHEN name='fence_wait' THEN dur_us END)/1000,
  quantile_cont(CASE WHEN name='fence_wait' THEN dur_us END, 0.9)/1000,
  avg(CASE WHEN name='submit_frame' THEN CAST(args->>'$.blend_complex' AS INT) END),
  count(CASE WHEN name='stall' THEN 1 END),
  avg(CASE WHEN name='stall' THEN dur_us END)/1000,
  count(CASE WHEN name='tick' THEN 1 END)
FROM events WHERE ts_us > {t0} + {skip}*1e6
""").fetchone()
fmt = lambda v, p=1: '—' if v is None else f'{v:.{p}f}'
print(f'{os.path.basename(f)} viewport={vp}')
print(f'  fps={fmt(r[0])}  submit={fmt(r[1],2)}ms  fence={fmt(r[2],2)}ms  fence_p90={fmt(r[3],2)}ms  complex/frame={fmt(r[4])}  stalls={r[5]} (avg {fmt(r[6])}ms)  frames={r[7]}')
