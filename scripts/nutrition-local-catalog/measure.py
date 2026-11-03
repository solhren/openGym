"""Measure only an explicitly supplied prototype command and its process tree.

No other service is sampled. /proc RSS includes shared pages in each process, so
aggregate RSS is a conservative footprint, not unique physical memory/PSS.
"""
import json
from pathlib import Path
import resource
import subprocess
import sys
import time

if len(sys.argv) < 2:
    raise SystemExit('usage: python3 measure.py COMMAND [ARG...]')
started = time.perf_counter()
child = subprocess.Popen(sys.argv[1:])
peak = samples = 0

def rss_tree(pid):
    total = 0
    try:
        lines = Path(f'/proc/{pid}/status').read_text().splitlines()
        total = next((int(l.split()[1])*1024 for l in lines if l.startswith('VmRSS:')), 0)
        descendants = Path(f'/proc/{pid}/task/{pid}/children').read_text().split()
        total += sum(rss_tree(int(p)) for p in descendants)
    except (OSError, ValueError):
        pass
    return total

while child.poll() is None:
    peak = max(peak, rss_tree(child.pid))
    samples += 1
    time.sleep(.025)
code = child.wait()
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
seconds = time.perf_counter()-started
print(json.dumps({'measurement': {'exitCode': code, 'seconds': seconds, 'sampledTreePeakRssBytes': peak, 'sampleIntervalMs': 25, 'samples': samples, 'cpuSeconds': usage.ru_utime+usage.ru_stime, 'cpuPercentOfOneCore': (usage.ru_utime+usage.ru_stime)/seconds*100, 'maxChildRssKiB': usage.ru_maxrss}}), file=sys.stderr)
raise SystemExit(code)
