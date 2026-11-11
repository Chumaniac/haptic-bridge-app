#!/bin/zsh
set -eu
cd -- "${0:A:h}"

hb_node=""
if command -v node >/dev/null 2>&1; then
  if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; then hb_node="$(command -v node)"; fi
fi
if [[ -z "$hb_node" ]]; then
  for hb_candidate in "$HOME"/.nvm/versions/node/v*/bin/node(NOn); do
    if "$hb_candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; then hb_node="$hb_candidate"; break; fi
  done
fi
if [[ -z "$hb_node" ]]; then
  print '需要 Node.js 24 或更新版本。安装后重新打开此启动文件。'
  read '?按回车关闭…'
  exit 1
fi
export PATH="${hb_node:h}:$PATH"
if node --input-type=module - <<'JS'
const port = process.env.HB_STUDIO_PORT ?? '18766';
if (!/^\d{1,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) process.exit(1);
try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800), redirect: 'error' });
  const data = await response.json();
  process.exit(response.ok && data.application === 'haptic-bridge-studio' && data.version === 1 && data.simulation === true ? 0 : 1);
} catch { process.exit(1); }
JS
then
  print "本地工作台已在运行：http://127.0.0.1:${HB_STUDIO_PORT:-18766}"
  if [[ "${HB_STUDIO_OPEN:-1}" == "1" ]]; then open "http://127.0.0.1:${HB_STUDIO_PORT:-18766}"; fi
  exit 0
fi
if [[ ! -d node_modules ]]; then npm ci --ignore-scripts; fi
npm run build
print '本地工作台即将打开。保留此终端窗口；按 Control+C 停止服务。'
HB_STUDIO_OPEN="${HB_STUDIO_OPEN:-1}" npm run start:studio
