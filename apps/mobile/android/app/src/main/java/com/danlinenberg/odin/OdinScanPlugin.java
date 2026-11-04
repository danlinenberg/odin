package com.danlinenberg.odin;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

/**
 * Scans the pair QR code in Odin (Settings > Remote > Phone) from inside the
 * app: Android camera apps don't reliably open an odin:// link, unlike the
 * iPhone Camera. Google's code scanner draws its own camera screen, so the
 * app asks for no camera permission. Answers {text}, or {} when cancelled.
 */
@CapacitorPlugin(name = "OdinScan")
public class OdinScanPlugin extends Plugin {
    @PluginMethod
    public void scan(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build();
        GmsBarcodeScanning.getClient(getActivity(), options)
            .startScan()
            .addOnSuccessListener(barcode -> {
                JSObject answer = new JSObject();
                answer.put("text", barcode.getRawValue());
                call.resolve(answer);
            })
            .addOnCanceledListener(() -> call.resolve(new JSObject()))
            .addOnFailureListener(e -> call.reject("Couldn't scan: " + e.getMessage()));
    }
}
