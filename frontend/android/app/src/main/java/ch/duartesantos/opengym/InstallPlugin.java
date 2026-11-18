package ch.duartesantos.opengym;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.MessageDigest;

/**
 * Minimal local Capacitor plugin that opens the Android package installer
 * for an APK file stored in the app's cache directory.
 *
 * Usage from JS:
 *   import { registerPlugin } from '@capacitor/core';
 *   const Install = registerPlugin('Install');
 *   await Install.canInstall();
 *   await Install.openInstallSettings();
 *   await Install.hasCachedApk({ fileName: 'opengym-update.apk', sha256: '<64 hex>' });
 *   await Install.installApk({ fileName: 'opengym-update.apk', sha256: '<64 hex>' });
 *
 * With `sha256` the file is streamed through SHA-256 first and a mismatch is refused (and the
 * file deleted) before the installer opens: the APK is ~300 MB, too big to hash in the WebView.
 * If "Install unknown apps" permission is not yet granted, the verified APK is kept in cache and
 * `ERR_UNKNOWN_SOURCES` is returned so installation can resume immediately after granting it.
 */
@CapacitorPlugin(name = "Install")
public class InstallPlugin extends Plugin {

    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                try {
                    Intent intent = new Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + getContext().getPackageName())
                    );
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);
                } catch (ActivityNotFoundException e) {
                    Intent fallback = new Intent(Settings.ACTION_SECURITY_SETTINGS);
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(fallback);
                }
            } else {
                Intent fallback = new Intent(Settings.ACTION_SECURITY_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
            }
            JSObject ret = new JSObject();
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not open install settings: " + e.getMessage(), "ERR_SETTINGS_FAILED");
        }
    }

    @PluginMethod
    public void hasCachedApk(PluginCall call) {
        String fileName = call.getString("fileName");
        if (!isSafeFileName(fileName)) {
            JSObject ret = new JSObject();
            ret.put("cached", false);
            call.resolve(ret);
            return;
        }

        File file = new File(getContext().getCacheDir(), fileName);
        if (!file.exists() || file.length() <= 0) {
            JSObject ret = new JSObject();
            ret.put("cached", false);
            call.resolve(ret);
            return;
        }

        String expected = call.getString("sha256");
        boolean cached = true;
        if (expected != null && !expected.isEmpty()) {
            try {
                cached = expected.equalsIgnoreCase(sha256(file));
                if (!cached) {
                    file.delete();
                }
            } catch (Exception e) {
                cached = false;
            }
        }

        JSObject ret = new JSObject();
        ret.put("cached", cached);
        call.resolve(ret);
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String fileName = call.getString("fileName");
        if (!isSafeFileName(fileName)) {
            call.reject("fileName is required", "ERR_INVALID_ARGS");
            return;
        }

        File file = new File(getContext().getCacheDir(), fileName);
        if (!file.exists()) {
            call.reject("APK file not found: " + fileName, "ERR_MISSING_FILE");
            return;
        }

        String expected = call.getString("sha256");
        if (expected != null && !expected.isEmpty()) {
            try {
                if (!expected.equalsIgnoreCase(sha256(file))) {
                    file.delete();
                    call.reject("SHA-256 mismatch: the download may be corrupted or tampered with", "ERR_HASH_MISMATCH");
                    return;
                }
            } catch (Exception e) {
                call.reject("Could not check the download: " + e.getMessage(), "ERR_HASH_READ");
                return;
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            // Keep `file` in cache: it passed SHA-256 verification and (~300 MB) can be
            // installed immediately once the user grants unknown-app install permission.
            call.reject("Unknown app installation permission is required", "ERR_UNKNOWN_SOURCES");
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    file
            );

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);

            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start package installer: " + e.getMessage(), "ERR_INSTALLER_FAILED");
        }
    }

    private static boolean isSafeFileName(String fileName) {
        return fileName != null
                && !fileName.isEmpty()
                && !fileName.contains("/")
                && !fileName.contains("\\")
                && !fileName.contains("..");
    }

    private static String sha256(File file) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] buf = new byte[1 << 16];
        try (InputStream in = new FileInputStream(file)) {
            for (int n; (n = in.read(buf)) > 0; ) md.update(buf, 0, n);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : md.digest()) hex.append(String.format("%02x", b));
        return hex.toString();
    }
}
