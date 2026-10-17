# Odin for iPhone

A Capacitor app around the phone screens in
`apps/desktop/src/renderer/mobile`. It talks to Odin on your Mac over the
same Wi-Fi (Settings > Connections > Phone).

## Run it on your iPhone

Needs Xcode (Mac App Store) and the iPhone plugged in or on the same Wi-Fi.

1. `bun run ios` here. It builds the screens, copies them into the Xcode
   project, and opens it in Xcode.
2. In Xcode: the App target > Signing & Capabilities > Team: pick your Apple
   ID. A free Apple ID works, but the app stops opening after 7 days; a paid
   developer account (and TestFlight, for other people's phones) doesn't expire.
3. Pick your iPhone at the top, press Run. The first time, the iPhone asks
   you to trust the developer: Settings > General > VPN & Device Management.
4. On the Mac, Odin > Settings > Connections > Phone > turn on Phone access.
   Scan the "iPhone app" QR code with the iPhone Camera: it opens the app and
   pairs. Allow "find devices on your local network" when iOS asks.

## Notes

- `ios/` is checked in; `cap sync` (part of `bun run ios`) rewrites
  `ios/App/CapApp-SPM/Package.swift` and the copied web assets.
- The icon and launch screen come from `apps/desktop/scripts/render-icons.py`.
  Never edit them by hand.
- Plain HTTP to the Mac (`NSAllowsLocalNetworking`); requests go through
  CapacitorHttp, natively, because the bundled page can't fetch http:// itself.
