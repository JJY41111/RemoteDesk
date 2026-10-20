"""Reproduce the report metrics with Python's standard library."""
from pathlib import Path
from datetime import datetime
import csv,json,math,statistics
ROOT=Path(__file__).resolve().parent
def num(row,key):
    try:
        value=float(row[key])
        return value if math.isfinite(value) else None
    except (KeyError,ValueError,TypeError):return None
def values(rows,key):return [v for r in rows if (v:=num(r,key)) is not None]
output=[]
for file in sorted(ROOT.glob('*.csv')):
    rows=list(csv.DictReader(file.open(encoding='utf-8-sig')))
    start=datetime.fromisoformat(rows[0]['time_utc'].replace('Z','+00:00'))
    for r in rows:r['_seconds']=(datetime.fromisoformat(r['time_utc'].replace('Z','+00:00'))-start).total_seconds()
    stress=file.name.startswith('stress')
    onset=next(r['_seconds'] for r in rows if r['_seconds']>=30 and (num(r,'rtt_ms') or 0)>=200) if stress else None
    chosen=[r for r in rows if 0<=r['_seconds']-onset<100] if stress else [r for r in rows if r['_seconds']>=30][:150]
    fps=values(chosen,'rendered_fps');rtt=values(chosen,'rtt_ms');rate=values(chosen,'wan_target_kbps')
    first_cut=next((r['_seconds']-onset for r in rows if stress and r['_seconds']>=onset and num(r,'wan_target_kbps') is not None and num(r,'wan_target_kbps')<8000),None)
    tail=[r for r in rows if r['_seconds']>=rows[-1]['_seconds']-20]
    output.append(dict(file=file.name,onset_seconds=onset,start=chosen[0]['time_utc'],end=chosen[-1]['time_utc'],n_fps=len(fps),mean_fps=statistics.mean(fps),low55_percent=100*sum(v<55 for v in fps)/len(fps),n_rtt=len(rtt),mean_rtt_ms=statistics.mean(rtt),mean_target_kbps=statistics.mean(rate),first_cut_after_onset_seconds=first_cut,tail20_mean_fps=statistics.mean(values(tail,'rendered_fps')),tail20_zero_count=sum(v==0 for v in values(tail,'rendered_fps'))))
(ROOT/'analysis.json').write_text(json.dumps(output,indent=2)+'\n',encoding='utf-8')
print(json.dumps(output,indent=2))
