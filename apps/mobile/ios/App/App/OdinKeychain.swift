import Capacitor
import Security

/// The phone's private key for the encrypted channel to Odin
/// (renderer/mobile/odin-fetch.ts): in the iOS Keychain, readable after the
/// first unlock, on this device only - never in a backup or on another phone.
@objc(OdinKeychainPlugin)
public class OdinKeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OdinKeychainPlugin"
    public let jsName = "OdinKeychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
    ]

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "odin",
            kSecAttrAccount as String: key,
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("No key") }
        var search = query(key)
        search[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(search as CFDictionary, &item)
        if status == errSecItemNotFound { return call.resolve([:]) }
        guard status == errSecSuccess, let data = item as? Data,
              let value = String(data: data, encoding: .utf8)
        else { return call.reject("Keychain error \(status)") }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            return call.reject("No key or value")
        }
        SecItemDelete(query(key) as CFDictionary)
        var item = query(key)
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        status == errSecSuccess ? call.resolve() : call.reject("Keychain error \(status)")
    }
}
