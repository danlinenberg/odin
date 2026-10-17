# The blind relay for the Odin iPhone app. No dependencies: Bun's own
# WebSocket server. Build from the repository root:
#   docker build -f packages/odin-relay/Dockerfile -t odin-relay .
FROM oven/bun:1.3.14-alpine
WORKDIR /app
COPY packages/odin-relay/src/relay.ts packages/odin-relay/src/main.ts ./src/
USER bun
EXPOSE 8443
CMD ["bun", "src/main.ts"]
