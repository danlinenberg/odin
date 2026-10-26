# The iPhone app in App Store Connect

Everything App Store Connect asks for, ready to paste, with the facts behind
each answer. The app is `apps/mobile` (screens in
`apps/desktop/src/renderer/mobile`). Screenshots come from
`bun run screenshots` in `apps/mobile`.

## Which path: TestFlight inside the team, or the App Store

The app is a client for Odin. Without one to pair with, it offers "Try the
demo" on its Pair screen: a sample board inside the app (the same samples as
`apps/mobile/scripts/fake-odin.ts`, in `apps/desktop/src/renderer/mobile/demo.ts`),
so a reviewer can use every screen.

| Path | Review | Who can install | What it needs |
|---|---|---|---|
| (a) Internal TestFlight | None | Up to 100 people who are users on the App Store Connect team | A paid developer account, the app record, an upload |
| (b) External TestFlight or the App Store | Beta App Review or App Review | Anyone with the link, or everyone | (a), plus the review notes below |

Recommendation: (a) now, for colleagues. Add each colleague in App Store
Connect > Users and Access (role: Developer or Marketing is enough), then add
them to the internal TestFlight group. (b) is ready whenever you want it.

## App information

| Field | Value | Limit |
|---|---|---|
| Name | Odin: Agent Board | 30 |
| Name, alternative | Odin for Agents | 30 |
| Subtitle | Your coding agents, anywhere | 30 |
| Bundle ID | `com.danlinenberg.odin` (as in `apps/mobile/capacitor.config.ts`) | |
| SKU | odin-ios | |
| Primary category | Developer Tools | |
| Secondary category | Productivity | |
| Copyright | 2026 Dan Linenberg | |
| Support URL | https://danlinenberg.github.io/odin/support.html | |
| Marketing URL | https://danlinenberg.github.io/odin/ | |
| Privacy Policy URL | https://danlinenberg.github.io/odin/privacy.html | |

"Odin" alone is almost certainly taken on the App Store; check the name in
App Store Connect when the app record is created. The bundle ID must be
registered under the paid team. Device builds made with a free personal team
used `com.danlinenberg.odin.y8yhq8j5sg` instead; the paid team uses the plain
ID.

## Promotional text (170)

> See which agents need you, answer them, and start new work from your phone. End to end encrypted between your iPhone and your own Odin.

## Description (4000)

> Odin runs many coding agents in parallel on your own Mac, and keeps them on one board: what needs you, what is working, what is ready for a final review. The iPhone app puts that board in your pocket.
>
> See the board
> Every session from your Odin, in the same columns as on the Mac: Needs you, Working, Final review and Idle, with your backlog and the work you finished. Each card says which repository it is in, who it is for, and whether it runs on your Mac or on a remote host. Starred sessions stay at the top. Sessions that just finished are marked.
>
> Answer from anywhere
> Open a session to read it as a chat, and watch it move while the agent works. Odin folds the steps in between and shows a short TL;DR first. When an agent asks a question, its action items appear as buttons: tap to approve, pick an option, or type your own answer. Reply in text or by voice. Attach a photo, a file or a screenshot of Odin itself from the + menu, or send a screenshot to Odin from any app's share sheet.
>
> Pick work back up
> Each session has a brief: the goal, what was done, where it stands and what comes next, with its pull requests, CI status, Jira issue and Slack thread.
>
> Start new work
> Write a task, choose the repository and priority, and save it to the backlog or start it at once.
>
> Profiles
> Switch between your Odin profiles, for example Work and Personal.
>
> End to end encrypted
> The phone and Odin talk over a Noise protocol channel (the framework WireGuard is built on). On your Wi-Fi the phone connects to your Mac directly. Away from it, the connection goes through a relay that forwards encrypted bytes it cannot read. Pairing happens once, by scanning a QR code on your Mac. The app has no account, no analytics and no ads.
>
> Requirements
> Odin on a Mac. Odin is free and open source: https://github.com/danlinenberg/odin

## Keywords (100)

```
agents,coding,developer,AI,terminal,pull request,kanban,jira,slack,board,queue,remote,CLI,worktree
```

Keywords must be separated by commas without spaces after them; a space
inside a keyword ("pull request") is fine. No trademarks of other companies:
those can get a listing rejected (Guideline 2.3.7).

## Age rating

Answer None to every content question (violence, sexual content, profanity,
drugs, gambling, horror, medical, and so on), No to unrestricted web access
and No to user-generated content shared with others. Result: 4+.

## App Privacy (the "nutrition label")

Answer: **Data Not Collected.**

Why that is true:

- The app contains no analytics, advertising or crash-reporting SDK. Its
  dependencies are Capacitor, its App and Keyboard plugins, React, and the
  open-source `@noble` crypto libraries.
- Everything the app sends (replies, photos, tasks, the board) goes end to
  end encrypted to the user's own Odin on their own Mac or server. The
  developer receives none of it.
- Away from the Wi-Fi, traffic passes through the Odin relay. It sees IP
  addresses, connection times and byte counts, never content, and it keeps no
  logs (`packages/odin-relay`, see its README). Apple counts data as
  "collected" when it is transmitted off the device in a way the developer can
  access beyond real-time servicing of the request; forwarding without
  storage is real-time servicing.
- Dictation uses Apple's speech recognition (`SFSpeechRecognizer`). Apple may
  process the audio under Apple's own privacy policy; that is Apple's
  processing, not collection by the developer. The speech permission text
  in `Info.plist` says so: "Odin turns what you say into a reply, using
  Apple's speech recognition."
- The phone's private key is stored in the iOS Keychain on the device only.
- Odin in the share sheet (the OdinShareExtension target) puts the shared
  images on a named pasteboard that only apps from the same team can read, on
  the device. Nothing leaves the phone until the user picks a session in the
  app, and then it goes through the encrypted channel like any attachment.

If the relay ever starts storing logs, this answer changes.

## Export compliance (encryption)

The app uses encryption beyond what iOS itself provides: its own Noise IK
channel (X25519, ChaCha20-Poly1305, BLAKE2s), from the open-source `@noble`
libraries. Answers to App Store Connect's questions, as best understood:

| Question | Answer |
|---|---|
| Does your app use encryption? | Yes |
| Does it qualify for an exemption in Category 5, Part 2 (for example, encryption limited to authentication, or only what the OS provides)? | No: it encrypts user content with its own code |
| Does it implement standard encryption algorithms instead of, or in addition to, Apple's? | Yes: standard, published algorithms, no proprietary ones |
| Is it available only in the US and Canada? | No, unless Dan restricts the territories |

`Info.plist` does not declare `ITSAppUsesNonExemptEncryption`. With the key
set to true, App Store Connect refuses the upload unless `Info.plist` also
carries an `ITSEncryptionExportComplianceCode` from approved export compliance
documentation. Without the key, the upload goes through and App Store Connect
asks the questions above on the build page. Add the key and the code once the
documentation is approved, so later uploads stop asking.

**Needs Dan's decision or a check (not settled here):**

- Whether the app counts as "mass market" under the US Export Administration
  Regulations (section 740.17(b)(1)), and whether an annual self-classification
  report to the US Bureau of Industry and Security (BIS) is required for it.
  Publicly available open-source code may be treated differently. This is a
  legal question; confirm it with Apple's export compliance guide or an
  adviser before an App Store release.
- France has its own declaration rules for encryption; App Store Connect
  asks about it when France is among the territories.
- Internal TestFlight builds still ask the encryption question on upload.

## App Review notes

> Odin for iPhone is a companion to Odin, an open-source app that runs coding agents on the user's own Mac. The app pairs with that Mac by scanning a QR code and has no account system.
>
> To review it without a Mac: on the Pair screen, tap "Try the demo". The app then shows a sample board with sessions that need attention, are working and are ready for review. Open "Fix HDR grouping test" to see a session as a chat, its action items (tap Approve), and its brief. Replies and new tasks in the demo stay on the device. "Pair with Odin" in the banner at the top leaves the demo.
>
> Odin is also in the iOS share sheet. Share a screenshot from Photos to Odin, then open Odin: it asks which session the image is for and puts it in that session's reply box. In the demo it stays on the device.
>
> Everything between the phone and a real Odin is end to end encrypted (Noise protocol). Source code: https://github.com/danlinenberg/odin

Sign-in required: No (the app has no accounts). Contact: Dan's name, email
and phone, filled in App Store Connect.

## TestFlight: What to Test

> Pair: on your Mac, open Odin > Settings > Remote > Phone, turn on Phone access, and scan the QR code with the iPhone Camera.
>
> Try: open a session that needs you and answer it with a button or a reply; send a reply by voice; attach a photo, and a screenshot of Odin from the + menu; share a screenshot to Odin from Photos; open the brief and its links; start a new task; star a session; switch profiles; open a session that runs on a remote host. Then turn off Wi-Fi and check that the board still loads over mobile data.
>
> Tell us about anything slow, confusing or broken, with a screenshot.

## The build

- Version 1.0, build 1: `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`,
  set once at the project level of the Xcode project, so the app and its
  share extension always carry the same numbers (App Store Connect refuses
  an upload where they differ). Raise the build number for every upload
  there, in the project's Build Settings under Versioning, not in a target's
  General tab, which writes a number for that one target only.
- Two targets go into the archive: App and OdinShareExtension
  (`com.danlinenberg.odin.share`, Odin in the share sheet). Both need the
  team set under Signing & Capabilities; with automatic signing Xcode
  registers the extension's App ID itself. The extension has no privacy
  manifest of its own because it calls none of the APIs that need a reason:
  it only writes to a named pasteboard.
- iPhone only (`TARGETED_DEVICE_FAMILY = 1`), so no iPad screenshots are
  needed. On an iPad it runs as an iPhone app.
- `App/PrivacyInfo.xcprivacy`: no tracking, no data collected, no
  required-reason APIs in the app's own code. Capacitor's frameworks carry
  their own manifests.
- `Info.plist`: a usage text for the camera, microphone, speech recognition
  and local network. No `ITSAppUsesNonExemptEncryption` (see Export
  compliance).
- The icon is 1024 x 1024 with no transparency, as the App Store requires.
- A Release archive builds and contains all of the above.

## Screenshots

6.9-inch iPhone display (1320 x 2868), required; App Store Connect scales
them down for smaller iPhones. Files in
`apps/mobile/store/screenshots/iphone-6.9/`, in this order:

1. `01-board.png` - the board: Needs you, Working, Final review, Idle, Backlog
2. `02-session.png` - a session as a chat, with its TL;DR and action items
3. `03-brief.png` - the brief panel: goal, progress, next step, PRs with CI, Jira, Slack
4. `04-new-task.png` - a new task with repository and priority
5. `05-pair.png` - pairing in four steps, and "Try the demo"

The data is fake-odin's sample sessions (`apps/mobile/scripts/fake-odin.ts`).
Regenerate with `bun run screenshots` in `apps/mobile` (about 30 seconds) after
any change to the phone screens: a screenshot has to show the app as it is
(Guideline 2.3.3). It needs no simulator: headless Google Chrome renders the
phone screens at the 6.9-inch size with the phone's safe areas, so the top
holds an empty status bar area.

The files must have no alpha channel. App Store Connect refuses a PNG that
has one, even when every pixel is opaque. `bun run screenshots` strips it at
the end
(`scripts/strip-alpha.py`, standard library Python). After making a
screenshot any other way, run `python3 scripts/strip-alpha.py
store/screenshots/iphone-6.9/*.png` in `apps/mobile`; `sips -g hasAlpha
file.png` shows the state.

## What Dan does in App Store Connect, in order

1. Confirm the paid Apple Developer membership is active, and note the Team
   ID.
2. In Certificates, Identifiers and Profiles: register the bundle ID
   `com.danlinenberg.odin`. The extension's `com.danlinenberg.odin.share` can
   be registered here too, or left to Xcode's automatic signing.
3. In App Store Connect > Apps > New App: platform iOS, name, language
   English (U.S.), the bundle ID, SKU `odin-ios`, full access.
4. Fill App Information, Pricing (Free) and App Privacy from this page.
5. In Xcode (`bun run ios` in `apps/mobile`): set the team on the App and
   OdinShareExtension targets, select "Any iOS Device", then Product >
   Archive, then Distribute App > App Store Connect > Upload.
6. Answer the encryption question for the build (see above).
7. TestFlight > Internal Testing: create a group, add colleagues (they must
   first be users on the team), and add the build. They get an email and
   install through the TestFlight app.
8. For external TestFlight or the App Store: add the screenshots and the
   review notes, and submit for review.
