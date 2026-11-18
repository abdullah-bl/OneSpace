#!/usr/bin/env bash
# OneSpace — local model servers (OpenAI-compatible, llama.cpp llama-server)
#
#   ./servers.sh start [main|fast|embed|rerank|all]   (default: all)
#   ./servers.sh stop  [main|fast|embed|rerank|all]
#   ./servers.sh status
#   ./servers.sh logs <name>
#
# All servers bind to 127.0.0.1 only. Ports/paths can be overridden by env vars.
set -euo pipefail

BIN="${LLAMA_SERVER:-$HOME/.unsloth/llama.cpp/llama-server}"
HUB="${HF_HUB:-$HOME/.cache/huggingface/hub}"
HOST="${BENCH_HOST:-127.0.0.1}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$DIR/run"; mkdir -p "$RUN"

MAIN_PORT="${MAIN_PORT:-8401}"
FAST_PORT="${FAST_PORT:-8402}"
EMBED_PORT="${EMBED_PORT:-8403}"
RERANK_PORT="${RERANK_PORT:-8404}"

MAIN_MODEL="${MAIN_MODEL:-$HUB/models--orcarouter--Qwen3.8-27B-Uncensored-GGUF/snapshots/c20535b9b8320ae6f8dd6868c72a793080125a6a/Qwen3.8-27B-Uncensored-Q4_K_M.gguf}"
MAIN_MMPROJ="${MAIN_MMPROJ:-$HUB/models--orcarouter--Qwen3.8-27B-Uncensored-GGUF/snapshots/c20535b9b8320ae6f8dd6868c72a793080125a6a/mmproj-Qwen3.8-27B-Uncensored-f16.gguf}"
MAIN_CTX="${MAIN_CTX:-262144}"      # total KV, shared by all slots (--kv-unified)
MAIN_PARALLEL="${MAIN_PARALLEL:-4}"
MAIN_EXTRA="${MAIN_EXTRA:-}"        # e.g. "--spec-type draft-mtp"

FAST_MODEL="${FAST_MODEL:-$HUB/models--AtomicChat--LFM3-1.7B-Uncensored-GGUF/snapshots/3ad712542eb9de349dbd28f2739b69c925cdec7d/LFM3-1.7B-Uncensored-AD-Q6_K.gguf}"
FAST_CTX="${FAST_CTX:-65536}"
FAST_PARALLEL="${FAST_PARALLEL:-4}"

EMBED_MODEL="${EMBED_MODEL:-$HUB/models--unsloth--embeddinggemma-2-GGUF/snapshots/031f0d4b35536f69ab3509d4893c923264fcf253/embeddinggemma-2-BF16.gguf}"
EMBED_CTX="${EMBED_CTX:-32768}"    # 4 slots x 8192 (model max per input = 8192)
EMBED_PARALLEL="${EMBED_PARALLEL:-4}"

RERANK_MODEL="${RERANK_MODEL:-$HUB/models--ggml-org--Qwen3-Reranker-0.6B-Q8_0-GGUF/snapshots/a02f48bb4f057028298c21fa033da2b30d7742d5/qwen3-reranker-0.6b-q8_0.gguf}"
RERANK_CTX="${RERANK_CTX:-16384}"

args_for() {
  case "$1" in
    main)   echo "-m $MAIN_MODEL --mmproj $MAIN_MMPROJ --alias qwen3.8-27b --port $MAIN_PORT -c $MAIN_CTX -np $MAIN_PARALLEL --kv-unified -ngl 999 -fa on --jinja --reasoning-format deepseek --metrics $MAIN_EXTRA" ;;
    fast)   echo "-m $FAST_MODEL --alias lfm3-1.7b --port $FAST_PORT -c $FAST_CTX -np $FAST_PARALLEL --kv-unified -ngl 999 -fa on --jinja --reasoning-format deepseek --metrics" ;;
    embed)  echo "-m $EMBED_MODEL --alias embeddinggemma-2 --port $EMBED_PORT -c $EMBED_CTX -np $EMBED_PARALLEL -b 8192 -ub 8192 -ngl 999 -fa on --embedding --metrics" ;;
    rerank) echo "-m $RERANK_MODEL --alias qwen3-reranker-0.6b --port $RERANK_PORT -c $RERANK_CTX -np 4 -b 8192 -ub 8192 -ngl 999 -fa on --reranking --metrics" ;;
    *) echo "unknown server: $1" >&2; exit 2 ;;
  esac
}
port_for() { case "$1" in main) echo $MAIN_PORT;; fast) echo $FAST_PORT;; embed) echo $EMBED_PORT;; rerank) echo $RERANK_PORT;; esac; }
names() { if [[ "${1:-all}" == all ]]; then echo main fast embed rerank; else echo "$1"; fi; }

is_running() { local f="$RUN/$1.pid"; [[ -f "$f" ]] && kill -0 "$(cat "$f")" 2>/dev/null; }

start_one() {
  local n=$1
  if is_running "$n"; then echo "$n: already running (pid $(cat "$RUN/$n.pid"))"; return; fi
  # shellcheck disable=SC2046
  nohup "$BIN" --host "$HOST" $(args_for "$n") >"$RUN/$n.log" 2>&1 &
  echo $! >"$RUN/$n.pid"
  echo "$n: starting pid $! on http://$HOST:$(port_for "$n")/v1"
}

wait_ready() {
  local n=$1 p; p=$(port_for "$n")
  for _ in $(seq 1 300); do
    if curl -sf "http://$HOST:$p/health" >/dev/null 2>&1; then echo "$n: ready"; return 0; fi
    is_running "$n" || { echo "$n: DIED — see $RUN/$n.log"; tail -20 "$RUN/$n.log"; return 1; }
    sleep 1
  done
  echo "$n: timeout waiting for health"; return 1
}

stop_one() {
  local n=$1
  if is_running "$n"; then kill "$(cat "$RUN/$n.pid")"; echo "$n: stopped"; else echo "$n: not running"; fi
  rm -f "$RUN/$n.pid"
}

cmd="${1:-status}"; target="${2:-all}"
case "$cmd" in
  start)  for n in $(names "$target"); do start_one "$n"; done
          for n in $(names "$target"); do wait_ready "$n"; done ;;
  stop)   for n in $(names "$target"); do stop_one "$n"; done ;;
  status) for n in main fast embed rerank; do
            if is_running "$n"; then
              h=$(curl -s -m2 "http://$HOST:$(port_for "$n")/health" || true)
              echo "$n: running pid $(cat "$RUN/$n.pid") port $(port_for "$n") health=$h"
            else echo "$n: stopped"; fi
          done ;;
  logs)   tail -50 "$RUN/$target.log" ;;
  *) echo "usage: $0 start|stop|status|logs [main|fast|embed|rerank|all]"; exit 2 ;;
esac
