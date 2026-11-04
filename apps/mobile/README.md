# Odin for iPhone

A Capacitor app around the phone screens in
`apps/desktop/src/renderer/mobile`. It talks to Odin over an end-to-end
encrypted channel, on the same Wi-Fi or through a relay you run
(Settings > Remote > Phone, and `docs/phone-encryption.md`).

## Run it on your iPhone

Needs Xcode (Mac App Store) and the iPhone plugged in or on the same Wi-Fi.

1. `bun run ios` here. It builds the screens, copies them into the Xcode
   project, and opens it in Xcode.
2. In Xcode: the App target > Signing & Capabilities > Team: pick your Apple
   ID. Do the same for the OdinShareExtension target (Odin in the share
   sheet) and the OdinWidgetExtension target (the lock screen widget): Xcode
   makes their signing profiles, the App Group and the push capability the
   first time. This needs a paid developer account: a free Apple ID can't
   sign push or an App Group, and its builds stop opening after 7 days. With
   a free Apple ID, delete the OdinWidgetExtension target and
   `App/App.entitlements` before you build; the rest of the app works.
3. Pick your iPhone at the top, press Run. The first time, the iPhone asks
   you to trust the developer: Settings > General > VPN & Device Management.
4. On the Mac, Odin > Settings > Remote > Phone > turn on Phone access.
   Scan the QR code with the iPhone Camera: it opens the app and pairs. Allow
   "find devices on your local network" when iOS asks. To reach Odin away
   from the Wi-Fi, set a relay in the same place before you scan.

## The lock screen widget

Long-press the lock screen > Customize > Lock Screen > add a widget > Odin.
It counts the sessions whose turn ended in the last hour and still wait on
you (Needs you or Final Review); a tap opens that list (`odin://ended`). The
app writes the count to the App Group (`group.$(ODIN_BUNDLE_ID)`) each time
the board loads. With the phone locked, Odin sends a silent push with the end
times when a turn ends, through Odin's relay, which signs it with the app's
APNs key (`packages/odin-relay`, `APNS_*`). Nobody sets up a key.

## Notes

- `ios/` is checked in; `cap sync` (part of `bun run ios`) rewrites
  `ios/App/CapApp-SPM/Package.swift` and the copied web assets.
- The icon and launch screen come from `apps/desktop/scripts/render-icons.py`.
  Never edit them by hand.
- Every request goes through the Noise channel over a WebSocket
  (`odin-fetch.ts`): `ws://` on the Wi-Fi (`NSAllowsLocalNetworking`), `wss://`
  to a relay. The phone's private key is in the Keychain, this device only.
- `bun run fake-odin` prints a pair link for the Simulator: the same channel,
  with sample sessions.
- The bundle ID is one setting, `ODIN_BUNDLE_ID` (the share extension is
  `$(ODIN_BUNDLE_ID).share`, the widget `$(ODIN_BUNDLE_ID).widget`). A build under another team overrides that, not
  `PRODUCT_BUNDLE_IDENTIFIER`, so the app and its extension move together.

## Odin for Android

The same screens in a Capacitor Android app (`android/`). Its native side is
smaller: `OdinKeychainPlugin.java` keeps the phone's key sealed by the Android
Keystore, and `OdinScanPlugin.java` scans the pair QR code in the app
(Google's code scanner, no camera permission), since Android camera apps
don't reliably open an `odin://` link. No speech to text, Screenshot this
screen, share sheet or widget yet: the screens hide those on Android
(`renderer/mobile/platform.ts`).

- `bun run android` builds the screens, syncs them in and builds
  `android/app/build/outputs/apk/debug/app-debug.apk`. Needs JDK 21 and the
  Android SDK (Android Studio has both). `bunx cap open android` opens it in
  Android Studio, where Run puts it on an emulator or a phone.
- `bun run android:test`, with an emulator running and the APK built: pairs
  it with `bun run fake-odin` through the `odin://pair` link and waits for the
  board. CI's `android` job runs it on every PR.
- Each Odin release attaches a signed `Odin.apk` (release.yml), which
  Settings > Remote > Phone links. Android installs it after you allow
  installs from the browser that downloaded it.
- The icons and launch screen come from `apps/desktop/scripts/render-icons.py`.
