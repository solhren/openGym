package ch.duartesantos.opengym;

import android.system.Os;
import android.system.OsConstants;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.RandomAccessFile;
import java.nio.channels.FileLock;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Private immutable JSON documents + two publication roots. No networking or model logic.
 * Single JVM executor avoids overlapping FileLocks; the OS lock also covers other processes.
 * All writes force file contents, rename on the same filesystem and force the parent directory.
 * A failure after root rename has an unknown outcome: JS reopens and verifies the exact root.
 */
@CapacitorPlugin(name = "NutritionStorage")
public class NutritionStoragePlugin extends Plugin {
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final int MAX_BYTES = 512 * 1024;
    private interface Work { JSObject run(File directory) throws Exception; }
    private static class StorageFailure extends Exception {
        final String code;
        StorageFailure(String code) { super(code); this.code = code; }
    }

    private void locked(PluginCall call, Work work) {
        String scope = call.getString("scope");
        if (scope == null || !scope.matches("[a-f0-9]{64}")) { call.reject("Invalid scope", "INVALID_SCOPE"); return; }
        IO.execute(() -> {
            try {
                File base = new File(getContext().getFilesDir(), "opengym-nutrition");
                makeDirectory(base);
                File directory = new File(base, scope);
                makeDirectory(directory);
                JSObject result;
                try (RandomAccessFile lockFile = new RandomAccessFile(new File(directory, ".lock"), "rw");
                     FileLock lock = lockFile.getChannel().lock()) {
                    result = work.run(directory);
                }
                // Release/close can fail after a durable publication: report an unknown outcome,
                // never resolve before cleanup and then attempt to reject the same call.
                call.resolve(result);
            } catch (StorageFailure error) { call.reject(error.getMessage(), error.code, error); }
            catch (Exception error) {
                // Retain the native error as a cause; never fall back to volatile storage.
                String code = error.getMessage() != null && error.getMessage().contains("ENOSPC") ? "QUOTA" : "IO_FAILED";
                call.reject("Nutrition storage failed", code, error);
            }
        });
    }

    private static void forceDirectory(File directory) throws Exception {
        FileDescriptor descriptor = Os.open(directory.getPath(), OsConstants.O_RDONLY | OsConstants.O_DIRECTORY, 0);
        try { Os.fsync(descriptor); } finally { Os.close(descriptor); }
    }
    private static void makeDirectory(File directory) throws Exception {
        if (!directory.isDirectory()) {
            if (!directory.mkdir() && !directory.isDirectory()) throw new StorageFailure("IO_FAILED");
        }
        // Also force an existing entry: another process may have just created it.
        forceDirectory(directory.getParentFile());
    }
    private static String read(File file) throws Exception {
        if (!file.exists()) return null;
        if (file.length() > MAX_BYTES) throw new StorageFailure("DOCUMENT_TOO_LARGE");
        // java.nio.file.Files is API 26; openGym still supports Android API 23.
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int length;
            while ((length = input.read(buffer)) != -1) {
                if (bytes.size() + length > MAX_BYTES) throw new StorageFailure("DOCUMENT_TOO_LARGE");
                bytes.write(buffer, 0, length);
            }
            // A lossy decoder can turn damaged bytes into a valid, checksummed U+FFFD value.
            // Reject malformed UTF-8 instead of silently repairing authoritative documents.
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
        }
    }
    private static void atomicWrite(File directory, String name, String text) throws Exception {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new StorageFailure("DOCUMENT_TOO_LARGE");
        File temporary = new File(directory, UUID.randomUUID() + ".tmp");
        // The unique temporary survives failure for conservative cleanup under the same lock.
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(bytes);
            output.getFD().sync();
        }
        Os.rename(temporary.getPath(), new File(directory, name).getPath());
        forceDirectory(directory);
    }
    private static String key(JSONObject row) throws Exception {
        String key = row.getString("key");
        if (!key.matches("[pm]-[a-f0-9]{64}")) throw new StorageFailure("INVALID_KEY");
        return key;
    }
    private static String nullable(JSONObject data, String field) throws Exception {
        if (!data.has(field)) throw new StorageFailure("INVALID_ARGUMENT");
        return data.isNull(field) ? null : data.getString(field);
    }

    @PluginMethod public void snapshot(PluginCall call) {
        locked(call, directory -> {
            JSObject result = new JSObject();
            String root = read(new File(directory, "root.json"));
            String previous = read(new File(directory, "previous.json"));
            result.put("root", root == null ? JSONObject.NULL : root);
            result.put("previous", previous == null ? JSONObject.NULL : previous);
            JSArray objects = new JSArray();
            File[] files = directory.listFiles();
            if (files == null) throw new StorageFailure("IO_FAILED");
            for (File file : files) {
                if (!file.getName().matches("[pm]-[a-f0-9]{64}\\.json")) continue;
                JSObject row = new JSObject();
                row.put("key", file.getName().substring(0, file.getName().length() - 5));
                row.put("text", read(file)); objects.put(row);
            }
            result.put("objects", objects);
            return result;
        });
    }

    @PluginMethod public void publish(PluginCall call) {
        locked(call, directory -> {
            JSONObject data = call.getData();
            String root = data.getString("root"), expected = nullable(data, "expectedRoot");
            String current = read(new File(directory, "root.json"));
            JSObject result = new JSObject();
            if (Objects.equals(current, root)) { result.put("repeated", true); return result; }
            if (!Objects.equals(current, expected)) throw new StorageFailure("STALE_ROOT");
            org.json.JSONArray writes = data.getJSONArray("writes");
            for (int i = 0; i < writes.length(); i++) {
                JSONObject row = writes.getJSONObject(i);
                String name = key(row) + ".json", text = row.getString("text");
                String existing = read(new File(directory, name));
                if (existing != null && !existing.equals(text)) throw new StorageFailure("INTEGRITY_CONFLICT");
                if (existing == null) atomicWrite(directory, name, text);
            }
            // previous is forced BEFORE root replacement. It is always an actually published root.
            if (current != null) atomicWrite(directory, "previous.json", current);
            atomicWrite(directory, "root.json", root);
            result.put("repeated", false);
            return result;
        });
    }

    @PluginMethod public void collect(PluginCall call) {
        locked(call, directory -> {
            JSONObject data = call.getData();
            if (!Objects.equals(read(new File(directory, "root.json")), nullable(data, "expectedRoot")) ||
                !Objects.equals(read(new File(directory, "previous.json")), nullable(data, "expectedPrevious")))
                throw new StorageFailure("STALE_ROOT");
            org.json.JSONArray keys = data.getJSONArray("keys");
            int deleted = 0;
            for (int i = 0; i < keys.length(); i++) {
                String key = keys.getString(i);
                if (!key.matches("[pm]-[a-f0-9]{64}")) throw new StorageFailure("INVALID_KEY");
                File file = new File(directory, key + ".json");
                if (file.exists()) { if (!file.delete()) throw new StorageFailure("IO_FAILED"); deleted++; }
            }
            File[] temporary = directory.listFiles(file -> file.getName().matches("[a-f0-9-]{36}\\.tmp"));
            if (temporary == null) throw new StorageFailure("IO_FAILED");
            for (File file : temporary) if (!file.delete()) throw new StorageFailure("IO_FAILED");
            forceDirectory(directory);
            JSObject result = new JSObject(); result.put("deleted", deleted); return result;
        });
    }
}
