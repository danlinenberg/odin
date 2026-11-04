package com.danlinenberg.odin;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OdinKeychainPlugin.class);
        registerPlugin(OdinScanPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
