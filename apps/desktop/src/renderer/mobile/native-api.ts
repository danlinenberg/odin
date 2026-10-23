/**
 * What the iOS app's native side offers the screens: its Capacitor plugins
 * and the Swift plugins in apps/mobile/ios (OdinKeychain, OdinSpeech, the
 * share extension's hand-off). Odin sends the phone new screens over the
 * channel (boot.ts), and a phone runs them only when this number matches the
 * one it was built with. Bump it when the screens start to need native code
 * an installed app lacks: that change waits for a rebuild in Xcode.
 */
export const NATIVE_API = 1;
