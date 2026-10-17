# Phone to Odin: end-to-end encryption through a blind relay

Status: draft for review, 2026-10-17

## Goal

The Odin iPhone app reaches an Odin host - the desktop app on a Mac today, an
Odin server on the user's own EC2 later - from anywhere, through a relay that
anyone can run. The relay must not be able to read or change what passes
through it. A person outside the organisation can use a public relay without
trusting its operator with their sessions, code or files.

The design must be checkable from the source: the encryption happens in Odin
and in the app, and the relay is a small program that only forwards bytes.

## What it protects, and what it does not

| Party | Can read content | Can change content | Can see |
|---|---|---|---|
| The relay operator | No | No (any change fails decryption) | IP addresses, times, sizes, the host's relay ID |
| The network (Wi-Fi, ISP, mobile operator) | No | No | The same as the relay, minus the relay ID |
| Someone with the relay address only | No | No | That a relay exists |
| A lost, unlocked phone | Yes | Yes | Everything the app shows; revoke that phone in Settings |
| A compromised Mac or EC2 | Yes | Yes | Everything; out of scope |

A relay can still refuse to forward (deny service). It cannot impersonate the
host or the phone.

## Parts

- **Host**: Odin's phone server (`apps/desktop/src/main/lib/phone`), later the
  same code in host-service on an EC2. Holds a long-term identity key and the
  list of trusted phones.
- **Phone**: the iPhone app (`apps/desktop/src/renderer/mobile`, built by
  `apps/mobile`). Holds its own long-term key and the host's public key.
- **Relay**: a new package, `packages/odin-relay` - a WebSocket forwarder of
  about 150 lines, with a Dockerfile, so anyone can run their own. It never
  holds a key.
- **Shared protocol code**: a new package, `packages/odin-channel`, used by
  both the host and the phone: the handshake, the encrypted frames, and the
  request/response format inside them.

## Identity and pairing

1. The host makes an X25519 key pair once and keeps the private key in
   `~/.odin/phone-identity` (mode 0600). On an EC2, the same file in the
   server's home.
2. Settings > Phone shows a QR code:
   `odin://pair?k=<host public key>&c=<pairing code>&r=<relay URL>&l=<LAN URL>`.
   - `k`: the host's public key, base64url, 32 bytes.
   - `c`: a one-time pairing code, 128 random bits, valid for 10 minutes.
   - `r`: the relay, `wss://...`. Optional.
   - `l`: the address on the local network, `ws://...`. Optional.
3. The phone makes its own X25519 key pair on first launch.
4. The first connection carries the pairing code inside the encrypted
   handshake. The host checks the code, then adds the phone's public key to its
   trusted list with a name ("Dan's iPhone") and the date.
5. Later connections need no code: the host accepts only phones on its list.
   Settings lists each phone with a Remove button. "Unpair all" clears the list
   and the identity key.

Because the phone learns the host's public key from the QR code, which is
scanned in person, a relay cannot put its own key in between: the handshake
fails.

This replaces today's shared bearer token.

## The handshake and the channel

- Pattern: **Noise IK**, `Noise_IK_25519_ChaChaPoly_BLAKE2s`. The phone
  (initiator) already knows the host's static key; the host learns the
  phone's static key in the first message, encrypted.
- Each connection uses fresh ephemeral keys: forward secrecy for past
  sessions if a long-term key leaks later.
- The phone sends its handshake payload: the pairing code on first use, else
  nothing, plus the protocol version.
- After the handshake, every message is a Noise transport message:
  ChaCha20-Poly1305 with a counter nonce, so a replayed, reordered or changed
  message fails.
- Noise caps a message at 65,535 bytes. Requests and responses are split into
  frames and joined on the other side.
- A connection lasts until either side closes it, at most 24 hours; then the
  phone reconnects with a new handshake.

### Library

Open decision. Options:

- **A (recommended).** The audited, pure-JavaScript `@noble/curves`,
  `@noble/ciphers` and `@noble/hashes`, with the Noise IK state machine written
  to the Noise specification (rev 34) and checked against the official
  test vectors in CI. Pure JS runs the same in Electron, Bun and the iPhone's
  web view.
- **B.** `noise-handshake` (Holepunch), a maintained Noise implementation. It
  depends on `sodium-universal` (native or WASM), which needs work to run in
  the iPhone's web view.

Either way, no other primitives and no other constructions.

## Inside the channel

The app's requests stay as they are today (`board`, `session`, `reply`,
`upload`, ...). The channel carries them as messages:

```
request:  { id, method, path, headers, body }
response: { id, status, headers, body }
```

`body` is bytes; an upload streams as frames of 60 KB. The host hands each
request to its existing HTTP app in-process, so the phone API is unchanged.

## Transport paths

All paths carry the same Noise channel. The app tries them in this order and
uses the first that completes a handshake:

1. **Local network**: `ws://<mac>.local:4747/channel`. This also replaces
   today's plain-HTTP API on the local network.
2. **Relay**: `wss://<relay>/connect/<host id>`.
3. **Direct to a server**: `wss://<server>/channel`, for an Odin on an EC2
   with a public address (later).

### Relay protocol

- The host's relay ID is `base64url(BLAKE2s(host public key))`, 22 characters.
  The relay learns only that this ID is one host; not its key, not its name.
- The host keeps one control connection open: `wss://<relay>/host/<id>`.
- A phone connects to `wss://<relay>/connect/<id>`. The relay sends the host
  `{ "incoming": "<session id>" }` on the control connection. The host opens
  `wss://<relay>/accept/<session id>`, and the relay joins the two sockets
  byte for byte.
- The relay never parses the bytes it forwards. It drops a pair when either
  side closes, and after 24 hours.
- Limits against abuse on a public relay: connections per IP, bytes per
  minute per session, idle timeout.

Known gap: anyone can register a control connection under another host's ID
and receive its phones' connection attempts. They cannot complete the
handshake, so this is denial of service only. A later version can make the
host prove ownership of the ID with a signature.

## Storage of keys

- Host: `~/.odin/phone-identity` (private key) and `~/.odin/phone-devices.json`
  (trusted phone keys), both mode 0600.
- Phone: first version in the app's local storage, inside the app's sandbox.
  Then the iOS Keychain, through a small native plugin, stored "this device
  only": protected by iOS data protection and never copied into a backup.

## What changes in today's code

- `server.ts`: adds the `/channel` WebSocket and the relay client; the bearer
  token goes away once the app speaks the channel. The plain-HTTP routes stay
  only on 127.0.0.1, for the desktop's own use.
- `relay.ts` (SSH tunnel) and the Caddy setup from PR #1133 are dropped.
- `odin-fetch.ts`: becomes a channel client with the same `odinFetch(path,
  init)` signature, so the screens do not change.
- The EC2 from today runs `packages/odin-relay` instead of Caddy, with
  Let's Encrypt for the relay's own `wss://` address. That certificate
  protects only the outer connection; the content is protected by Noise.

## Testing

- Noise: the official test vectors for `Noise_IK_25519_ChaChaPoly_BLAKE2s`.
- A wrong host key, a wrong phone key, an expired or reused pairing code, and
  a changed byte in transit each fail.
- The relay: a test sends a known plaintext through it and asserts that the
  relay never sees those bytes.
- End to end in the iOS Simulator against a local relay and a real Odin.

## Open questions

1. Library: A (noble + Noise IK to the spec) or B (`noise-handshake`).
2. A default public relay: run by whom, at which address, and with which
   limits.
3. iOS Keychain from the first version, or local storage first.
