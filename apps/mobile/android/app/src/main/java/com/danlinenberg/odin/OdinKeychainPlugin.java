package com.danlinenberg.odin;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The phone's private key for the encrypted channel to Odin
 * (renderer/mobile/odin-fetch.ts), the Android side of OdinKeychain.swift:
 * sealed with an AES key that never leaves the Android Keystore, so the
 * stored text is useless off this device. The app turns backups off
 * (allowBackup="false"), so it never reaches another phone either.
 */
@CapacitorPlugin(name = "OdinKeychain")
public class OdinKeychainPlugin extends Plugin {
    private static final String ALIAS = "odin-keychain";
    private static final String PREFS = "odin-keychain";

    private SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        );
        return generator.generateKey();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("No key");
            return;
        }
        String sealed = prefs().getString(key, null);
        if (sealed == null) {
            call.resolve(new JSObject());
            return;
        }
        try {
            String[] parts = sealed.split(":", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            byte[] plain = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
            JSObject answer = new JSObject();
            answer.put("value", new String(plain, StandardCharsets.UTF_8));
            call.resolve(answer);
        } catch (Exception e) {
            call.reject("Keystore error: " + e.getMessage());
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("No key or value");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String text = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP);
            prefs().edit().putString(key, text).commit();
            call.resolve();
        } catch (Exception e) {
            call.reject("Keystore error: " + e.getMessage());
        }
    }
}
