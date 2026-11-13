#!/bin/zsh
cd "${0:A:h}"
if [[ ! -d node_modules ]]; then
 echo "请先在本目录执行 npm ci，再双击启动。"; read; exit 1
fi
if lsof -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
 echo "4317 端口已被占用，请检查已有服务。本程序不会关闭其他进程。"; read; exit 1
fi
node server/index.js &
reader_pid=$!
trap 'kill "$reader_pid" 2>/dev/null' EXIT INT TERM
for i in {1..30}; do
 if curl -fsS http://127.0.0.1:4317/api/health >/dev/null; then open http://127.0.0.1:4317; wait "$reader_pid"; exit; fi
 sleep 0.2
done
echo "启动失败，请查看上方信息。"
