# The phone and Odin: end-to-end encrypted, through a blind relay

> **Status: design, not built yet.** Today the iPhone app talks to Odin on the
> same Wi-Fi over plain HTTP with a shared token. This document is the design
> that replaces it. It is here so it can be read and checked before the code
> lands, and so the code can be checked against it after.

The Odin iPhone app reaches an Odin host - the desktop app on a Mac today, an
Odin server on your own EC2 later - from anywhere, through a relay that anyone
can run. The relay cannot read or change what passes through it. Someone
outside the organisation can use a relay run by someone else without trusting
that person with their sessions, code or files.

The encryption happens in Odin and in the app. The relay is a small program
that only forwards bytes. Both are in this repository, so all of this can be
checked from the source.

## The picture

Pairing happens once, in person. After that, the app tries the paths in order
and uses the first one that completes a handshake. Everything marked
`[Noise 🔒]` is encrypted between the phone and Odin; nothing in between can
read it.

```
 PAIRING (once, in person)
 ┌──────────────┐   scan QR: Odin public key + one-time code    ┌──────────────┐
 │  iPhone app  │ ◀──────────────────────────────────────────── │ Odin (Mac or │
 │  phone key   │ ── first handshake: phone key + code ───────▶ │ EC2), host   │
 └──────────────┘    → Odin adds this phone to its trusted list │ key          │
                                                                └──────────────┘

 CONNECTING (every time; the app tries 1, then 2, then 3)

 1. Same Wi-Fi                                    ┌────────────────────┐
 ┌────────┐ ═══════[Noise 🔒]════════════════════▶ │ Odin on the Mac    │
 │ iPhone │   ws://mac.local:4747/channel          └────────────────────┘
 └────────┘

 2. Anywhere, through a relay
 ┌────────┐ ═[Noise 🔒]═▶ ┌───────────────────┐ ═[Noise 🔒]═▶ ┌─────────────┐
 │ iPhone │  wss://relay  │  RELAY (blind)    │ ◀── outbound ─│ Odin on Mac │
 └────────┘               │  joins 2 sockets, │    connection │ or private  │
                          │  forwards bytes   │    from Odin  │ EC2         │
                          │  holds NO key     │               └─────────────┘
                          └───────────────────┘

 3. Direct to an EC2 with a public address
 ┌────────┐ ═══[ HTTPS ┌ Noise 🔒 ┐ ]═══════════▶ ┌────────────────────┐
 │ iPhone │   wss://my-odin.example/channel       │ Odin on the EC2    │
 └────────┘                                       └────────────────────┘
```

Inside every connection, the app's requests travel in sealed frames:

```
 iPhone                                                   Odin
  │  Noise IK handshake (fresh keys for each connection)    │
  │ ─────────────────────────────────────────────────────▶ │  is this phone trusted?
  │ ◀───────────────────────────────────────────────────── │
  │  [ {id:1, GET /trpc/board} ] 🔒                         │
  │ ─────────────────────────────────────────────────────▶ │  the existing phone API
  │  [ {id:1, 200, {sessions…}} ] 🔒                        │
  │ ◀───────────────────────────────────────────────────── │
```

## What it protects, and what it does not

| Party | Reads content | Changes content | Sees |
|---|---|---|---|
| The relay operator | No | No - any change fails decryption | IP addresses, times, sizes, the host's relay ID |
| The network (Wi-Fi, ISP, mobile operator) | No | No | The same, minus the relay ID |
| An attacker in the middle | No | No | The handshake fails |
| A lost, unlocked phone | Yes | Yes | Everything the app shows - remove that phone in Settings |
| A compromised Mac or EC2 | Yes | Yes | Everything - out of scope |

A relay can refuse to forward: that is denial of service, not a leak. It
cannot pretend to be your Odin or your phone.

## Parts

- **Host**: Odin's phone server (`apps/desktop/src/main/lib/phone`), and later
  the same code in host-service on an EC2. Holds a long-term identity key and
  the list of trusted phones.
- **Phone**: the iPhone app (`apps/desktop/src/renderer/mobile`, built by
  `apps/mobile`). Holds its own long-term key and the host's public key.
- **Relay**: `packages/odin-relay` - a WebSocket forwarder of about 150 lines,
  with a Dockerfile, so anyone can run their own. It never holds a key.
- **Channel**: `packages/odin-channel`, used by both the host and the phone -
  the handshake, the encrypted frames, and the request and response format
  inside them.

## Identity and pairing

1. The host makes an X25519 key pair once and keeps the private key in
   `~/.odin/phone-identity` (mode 0600). On an EC2, the same file in the
   server's home. The private key never leaves the machine.
2. Settings > Phone shows a QR code:
   `odin://pair?k=<host public key>&c=<pairing code>&r=<relay URL>&l=<LAN URL>`
   - `k`: the host's public key, base64url, 32 bytes.
   - `c`: a one-time pairing code, 128 random bits, valid for 10 minutes.
   - `r`: the relay, `wss://…`, when one is set.
   - `l`: the address on the local network, `ws://…`.
3. The phone makes its own X25519 key pair on first launch.
4. The first connection carries the pairing code inside the encrypted
   handshake. The host checks the code, then adds the phone's public key to its
   trusted list with a name ("Dan's iPhone") and the date.
5. Later connections need no code: the host accepts only phones on its list.
   Settings lists each phone with Remove. "Unpair all" clears the list and
   makes a new host key.

The phone learns the host's public key from a QR code scanned in person, so a
relay cannot put its own key in between: the handshake fails.

This replaces today's shared bearer token.

## The handshake and the channel

- Pattern: **Noise IK**, `Noise_IK_25519_ChaChaPoly_BLAKE2s`, from the
  [Noise Protocol Framework](https://noiseprotocol.org/noise.html), the
  framework WireGuard and WhatsApp are built on. The phone (initiator) already
  knows the host's static key; the host learns the phone's static key in the
  first message, encrypted.
- Each connection uses fresh ephemeral keys, so a long-term key that leaks
  later does not decrypt earlier sessions (forward secrecy).
- The phone's handshake payload carries the protocol version and, on first
  use, the pairing code.
- After the handshake, every message is a Noise transport message:
  ChaCha20-Poly1305 with a counter nonce, so a replayed, reordered or changed
  message fails.
- Noise caps a message at 65,535 bytes, so requests and responses are split
  into frames and joined on the other side.
- A connection lasts until either side closes it, at most 24 hours; then the
  phone reconnects with a new handshake.

### Library

The audited, pure-JavaScript [`@noble/curves`](https://github.com/paulmillr/noble-curves),
[`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) and
[`@noble/hashes`](https://github.com/paulmillr/noble-hashes) provide X25519,
ChaCha20-Poly1305 and BLAKE2s. The Noise IK state machine is written to the
Noise specification (revision 34) and checked in CI against the official test
vectors for this exact protocol name. Pure JavaScript runs the same in
Electron, Bun and the iPhone's web view, with no native or WASM binding to
trust.

No other primitives and no other constructions.

## Inside the channel

The app's requests stay as they are today (`board`, `session`, `reply`,
`upload`, …). The channel carries them as messages:

```
request:  { id, method, path, headers, body }
response: { id, status, headers, body }
```

`body` is bytes; an upload streams as frames of 60 KB. The host hands each
request to its existing HTTP app in-process, so the phone API does not change.

## Transport paths

All paths carry the same Noise channel. The app tries them in order and uses
the first that completes a handshake:

1. **Local network**: `ws://<mac>.local:4747/channel`. This also replaces
   today's plain-HTTP API on the local network.
2. **Relay**: `wss://<relay>/connect/<host id>`.
3. **Direct to a server**: `wss://<server>/channel`, for an Odin on an EC2
   with a public address.

### Relay protocol

- The host's relay ID is `base64url(BLAKE2s(host public key))`, 22 characters.
  The relay learns only that this ID is one host: not its key, not its name.
- The host keeps one control connection open: `wss://<relay>/host/<id>`.
- A phone connects to `wss://<relay>/connect/<id>`. The relay sends the host
  `{ "incoming": "<session id>" }` on the control connection. The host opens
  `wss://<relay>/accept/<session id>`, and the relay joins the two sockets byte
  for byte.
- The relay never parses the bytes it forwards. It drops a pair when either
  side closes, and after 24 hours.
- Limits against abuse: connections per IP, bytes per minute per session, an
  idle timeout.

Known gap: anyone can register a control connection under another host's ID
and receive its phones' connection attempts. They cannot complete the
handshake, so this is denial of service only. A later version makes the host
prove ownership of its ID.

### Which relay

There is no default relay. You run your own - one `docker run` on any server,
an EC2 included - and give Odin its address in Settings > Phone. A public relay
may come later; until then, nobody's traffic goes through a server they didn't
choose. Even then, a relay cannot read it.

## Storage of keys

- **Host**: `~/.odin/phone-identity` (the private key) and
  `~/.odin/phone-devices.json` (the trusted phones' public keys), both mode
  0600.
- **Phone**: the iOS Keychain, through a small native plugin in `apps/mobile`,
  stored "this device only": protected by iOS data protection and never copied
  into a backup.

## Testing

- Noise: the official test vectors for `Noise_IK_25519_ChaChaPoly_BLAKE2s`.
- A wrong host key, a wrong phone key, an expired or reused pairing code, and
  a changed byte in transit each fail.
- The relay: a test sends a known plaintext through it and asserts the relay
  never sees those bytes.
- End to end in the iOS Simulator against a local relay and a real Odin.
