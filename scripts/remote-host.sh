#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
	echo "usage: scripts/remote-host.sh <ssh-host>" >&2
	exit 64
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_VERSION="$(cat "$ROOT/.bun-version")"
NODE_VERSION="${ODIN_REMOTE_NODE_VERSION:-22.14.0}"
REMOTE_DIR=".odin-remote"
PORT="${ODIN_REMOTE_PORT:-4879}"
SSH=(ssh ${ODIN_SSH_OPTS:-} "$TARGET")

"${SSH[@]}" bash -se <<REMOTE
set -euo pipefail
mkdir -p "\$HOME/$REMOTE_DIR/src"

if [ ! -x "\$HOME/.bun/bin/bun" ] || [ "\$(\$HOME/.bun/bin/bun --version)" != "$BUN_VERSION" ]; then
	curl -fsSL https://bun.sh/install | BUN_INSTALL="\$HOME/.bun" bash -s "bun-v$BUN_VERSION" >/dev/null 2>&1
fi

NODE_DIR="\$HOME/$REMOTE_DIR/node"
if [ ! -x "\$NODE_DIR/bin/node" ] || [ "\$(\$NODE_DIR/bin/node --version)" != "v$NODE_VERSION" ]; then
	case "\$(uname -m)" in
		aarch64|arm64) NODE_ARCH=arm64 ;;
		x86_64) NODE_ARCH=x64 ;;
		*) echo "unsupported architecture: \$(uname -m)" >&2; exit 1 ;;
	esac
	rm -rf "\$NODE_DIR"
	mkdir -p "\$NODE_DIR"
	curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-\$NODE_ARCH.tar.gz" \
		| tar xz -C "\$NODE_DIR" --strip-components=1
fi
REMOTE

git -C "$ROOT" archive HEAD | "${SSH[@]}" "tar x -C \$HOME/$REMOTE_DIR/src"

SECRET="$("${SSH[@]}" bash -se <<REMOTE
set -euo pipefail
export PATH="\$HOME/.bun/bin:\$HOME/$REMOTE_DIR/node/bin:\$PATH"
cd "\$HOME/$REMOTE_DIR"

[ -f env ] || cat > env <<ENV
HOST_SERVICE_SECRET=\$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')
ORGANIZATION_ID=\$(cat /proc/sys/kernel/random/uuid)
ENV
. ./env

if [ -f host-service.pid ] && kill -0 "\$(cat host-service.pid)" 2>/dev/null; then
	kill "\$(cat host-service.pid)"
	while kill -0 "\$(cat host-service.pid)" 2>/dev/null; do sleep 0.2; done
fi

cd src
CI=1 bun install --frozen-lockfile >"\$HOME/$REMOTE_DIR/install.log" 2>&1

for NATIVE in better-sqlite3 node-pty; do
	DIR=\$(ls -d node_modules/.bun/\$NATIVE@*/node_modules/\$NATIVE 2>/dev/null | head -1 || true)
	if [ -z "\$DIR" ]; then continue; fi
	(cd "\$DIR" && npm rebuild --build-from-source) >>"\$HOME/$REMOTE_DIR/install.log" 2>&1
done

(cd packages/pty-daemon && bun run build.ts) >>"\$HOME/$REMOTE_DIR/install.log" 2>&1
cd packages/host-service
bun run build.ts >>"\$HOME/$REMOTE_DIR/install.log" 2>&1
cp ../pty-daemon/dist/*.js dist/
if [ ! -f dist/pty-daemon.js ]; then
	echo "pty-daemon bundle missing from dist/; terminals would fail to start" >&2
	exit 1
fi

for SPEC in \$(grep -hoE 'from *"[^".][^"]*"' dist/*.js \
	| sed 's/.*"\(.*\)"/\1/' | grep -v '^node:' \
	| awk -F/ '/^@/{print \$1"/"\$2} !/^@/{print \$1}' | sort -u); do
	if [ -e "node_modules/\$SPEC" ]; then continue; fi
	STORE=\$(ls -d "../../node_modules/.bun/\$(echo "\$SPEC" | tr / +)"@* 2>/dev/null | head -1 || true)
	if [ -z "\$STORE" ] || [ ! -d "\$STORE/node_modules/\$SPEC" ]; then continue; fi
	mkdir -p "node_modules/\$(dirname "\$SPEC")"
	ln -sfn "\$(cd "\$STORE/node_modules/\$SPEC" && pwd)" "node_modules/\$SPEC"
done

HOST_SERVICE_SECRET="\$HOST_SERVICE_SECRET" \
ORGANIZATION_ID="\$ORGANIZATION_ID" \
HOST_DB_PATH="\$HOME/$REMOTE_DIR/host.db" \
HOST_MIGRATIONS_FOLDER="\$HOME/$REMOTE_DIR/src/packages/host-service/drizzle" \
PORT="$PORT" \
NODE_ENV=production \
	setsid nohup node dist/host-service.js \
	>"\$HOME/$REMOTE_DIR/host-service.log" 2>&1 &

echo \$! > "\$HOME/$REMOTE_DIR/host-service.pid"

for _ in \$(seq 1 60); do
	if curl -fsS -H "Authorization: Bearer \$HOST_SERVICE_SECRET" \
		"http://127.0.0.1:$PORT/trpc/health.check" >/dev/null 2>&1; then
		echo "\$HOST_SERVICE_SECRET"
		exit 0
	fi
	sleep 1
done
echo "host-service did not become healthy; see \$HOME/$REMOTE_DIR/host-service.log" >&2
tail -40 "\$HOME/$REMOTE_DIR/host-service.log" >&2
exit 1
REMOTE
)"

echo "ODIN_REMOTE_PORT=$PORT"
echo "ODIN_REMOTE_SECRET=$SECRET"
echo "tunnel: ssh ${ODIN_SSH_OPTS:-} -N -L $PORT:127.0.0.1:$PORT $TARGET"
