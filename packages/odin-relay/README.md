# odin-relay

The relay that lets the Odin iPhone app reach your Odin from anywhere,
without being able to read anything that passes through it. The design, and
exactly what a relay can and cannot see, is in
[docs/phone-encryption.md](../../docs/phone-encryption.md).

In short: the phone and Odin talk Noise IK end to end
([`packages/odin-channel`](../odin-channel)). This program only joins a
phone's WebSocket to the Odin it asked for and forwards the bytes. It never
parses them and holds no key. Read [`src/relay.ts`](src/relay.ts) - it is
short.

## Run your own

It needs a public address that phones can reach over HTTPS: an inbound 443
port and a TLS name. A private server with no inbound access can still run
Odin and use a relay, but it cannot be one.

With Docker, behind a TLS proxy (Caddy, a load balancer) that forwards
WebSockets to port 8443:

```sh
docker build -f packages/odin-relay/Dockerfile -t odin-relay .
docker run -d --restart=always -p 127.0.0.1:8443:8443 -e TRUST_PROXY=1 odin-relay
```

Or let the relay serve TLS itself with your certificate:

```sh
docker run -d --restart=always -p 443:8443 \
  -v /etc/letsencrypt/live/relay.example.com:/certs:ro \
  -e TLS_CERT=/certs/fullchain.pem -e TLS_KEY=/certs/privkey.pem \
  odin-relay
```

Then give Odin the relay's address: `"relay": "wss://relay.example.com"` in
`~/.odin/phone.json`, and restart Odin. Without one, Odin uses the default relay
(`DEFAULT_RELAY` in `apps/desktop/src/main/lib/phone/server.ts`).

## The widget's push

Odin's own relay also signs the lock screen widget's silent pushes
(`src/push.ts`, `POST /push`) with the App Store app's APNs key, so no Odin
user needs one. Give it the key with these, and mount the `.p8` read-only:

```sh
docker run -d --restart=always -p 127.0.0.1:8443:8443 -e TRUST_PROXY=1 \
  -v /etc/odin/AuthKey_XXXXXXXXXX.p8:/keys/apns.p8:ro \
  -e APNS_KEY_FILE=/keys/apns.p8 -e APNS_KEY_ID=XXXXXXXXXX \
  -e APNS_TEAM_ID=YYYYYYYYYY -e APNS_TOPIC=com.danlinenberg.odin \
  odin-relay
```

Without them, `/push` answers 503 and the rest works as before. A push holds
only end times; the relay stores no token, and pushes to one phone at most
every 20 seconds, 60 a minute per IP address.

## Limits

For a relay that strangers can use: 32 sockets per IP address, one Noise
message (about 64 KB) per WebSocket message, 100 MB a minute per session,
pings with a 2-minute idle timeout, and 24 hours per session.

## What it logs

Nothing beyond its start line. What it could log, if changed to: IP
addresses, times, sizes, and each host's 22-character relay ID. Never
content - see the test that sends a secret through it and checks every
forwarded byte.
