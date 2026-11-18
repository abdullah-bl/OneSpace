#!/usr/bin/env bash
# Full Phase-0 run. Assumes ./servers.sh start all. Case counts via run.py flags (see run.py --help).
set -euo pipefail
cd "$(dirname "$0")"
python3 gen_corpus.py                       # cached after first run
python3 run.py format select multi code cite abstain recall perf think context ocr fast "$@"
# MTP speculative decoding comparison (restarts main server)
MAIN_EXTRA="--spec-type draft-mtp" ./servers.sh stop main
MAIN_EXTRA="--spec-type draft-mtp" ./servers.sh start main
python3 -c "import run; run.test_perf(tag='perf_mtp')"
python3 -c "import run; run.test_multi(10, tag='multi_mtp')"   # sanity: quality unchanged with MTP
./servers.sh stop main && ./servers.sh start main
