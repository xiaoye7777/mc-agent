#!/usr/bin/env bash
# 本地真·测试服：Paper 1.21.6（和朋友的公网服同版本），用来放心地测移动、砍树、战斗。
#
# 用法：npm run test-server
#   - 第一次运行会从 PaperMC 官方下载服务端（约 50MB），放在 local-server/ 里（不进 git）
#   - 需要 Java 21 或更新：brew install openjdk
#   - 第一次启动前会让你确认 Minecraft EULA
#   - 启动后在这个终端里可以直接敲服务器命令，比如：op 你的名字、time set day、give 你的名字 oak_log 16
#
# NPC 连过来：.env 里 MC_HOST=localhost、MC_PORT=25565，然后另开终端 npm start。
set -euo pipefail

MC_VERSION="1.21.6"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="${ROOT}/local-server"
JAR="${SERVER_DIR}/paper-${MC_VERSION}.jar"
API="https://fill.papermc.io/v3/projects/paper/versions/${MC_VERSION}/builds/latest"
USER_AGENT="mc-agent-test-server/1.0"

mkdir -p "${SERVER_DIR}"
cd "${SERVER_DIR}"

# ---- 1. 找 Java（要 21+）----
JAVA_BIN="${JAVA_BIN:-}"
if [ -z "${JAVA_BIN}" ]; then
  if java -version >/dev/null 2>&1; then
    JAVA_BIN="java"
  elif [ -x /opt/homebrew/opt/openjdk/bin/java ]; then
    JAVA_BIN="/opt/homebrew/opt/openjdk/bin/java"
  else
    echo "没找到 Java。先安装：brew install openjdk（或者设置 JAVA_BIN=java 的路径）"
    exit 1
  fi
fi

# ---- 2. 下载 Paper（只在第一次）----
if [ ! -f "${JAR}" ]; then
  echo "下载 Paper ${MC_VERSION} ..."
  BUILD_JSON="$(curl -fsSL -A "${USER_AGENT}" "${API}")"
  URL="$(node -e 'const d=JSON.parse(process.argv[1]).downloads["server:default"]; console.log(d.url)' "${BUILD_JSON}")"
  SHA="$(node -e 'const d=JSON.parse(process.argv[1]).downloads["server:default"]; console.log(d.checksums.sha256)' "${BUILD_JSON}")"
  curl -fL -A "${USER_AGENT}" -o "${JAR}.part" "${URL}"
  echo "${SHA}  ${JAR}.part" | shasum -a 256 -c - >/dev/null || { echo "校验失败，删掉重下"; rm -f "${JAR}.part"; exit 1; }
  mv "${JAR}.part" "${JAR}"
fi

# ---- 3. EULA：必须由你本人同意 ----
if ! grep -q "eula=true" eula.txt 2>/dev/null; then
  echo "启动 Minecraft 服务端需要同意 EULA：https://aka.ms/MinecraftEULA"
  read -r -p "同意请输入 yes：" answer
  [ "${answer}" = "yes" ] || { echo "没有同意，退出。"; exit 1; }
  echo "eula=true" > eula.txt
fi

# ---- 4. 测试服配置（只在第一次写，之后你改了不会被覆盖）----
if [ ! -f server.properties ]; then
  cat > server.properties <<'EOF'
motd=mc-agent local test server
online-mode=false
server-port=25565
gamemode=survival
difficulty=easy
level-seed=mc-agent
spawn-protection=0
allow-flight=true
view-distance=6
simulation-distance=6
max-players=10
enforce-secure-profile=false
EOF
  # spawn-protection=0：出生点附近也能砍树（默认 16 格内非 OP 不能挖）
  # allow-flight=true：机器人寻路偶尔会被误判成飞行而踢掉，测试服关掉这个检查
fi

# 关掉 Paper 自带的 spark 后台性能分析：它的原生组件在新版 Java（26）上会让服务器崩溃
if [ ! -f plugins/spark/config.json ]; then
  mkdir -p plugins/spark
  printf '{\n  "backgroundProfiler": false\n}\n' > plugins/spark/config.json
fi

echo "启动 Paper ${MC_VERSION}（localhost:25565）... 停止服务器：输入 stop"
exec "${JAVA_BIN}" -Xms1G -Xmx2G -jar "${JAR}" --nogui
