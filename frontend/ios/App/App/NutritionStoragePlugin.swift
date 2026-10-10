import Foundation
import Capacitor
import Darwin

// The JS coordinator owns format validation and retention. This bridge owns private I/O,
// process/file isolation and durable atomic publication. No filesystem/network dependency.
@objc(NutritionStoragePlugin)
public class NutritionStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NutritionStoragePlugin"
    public let jsName = "NutritionStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "headers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readDocuments", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveIndex", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "collect", returnType: CAPPluginReturnPromise)
    ]
    private static let io = DispatchQueue(label: "opengym.nutrition.storage")
    private let maximum = 512 * 1024
    private struct Failure: Error { let code: String }
    private func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
    private func systemCheck(_ result: Int32) throws {
        if result == -1 { throw Failure(code: errno == ENOSPC ? "QUOTA" : "IO_FAILED") }
    }
    private func withDescriptor<T>(_ descriptor: Int32, _ body: (Int32) throws -> T) throws -> T {
        try systemCheck(descriptor)
        let result: Result<T, Error>
        do { result = .success(try body(descriptor)) }
        catch { result = .failure(error) }
        // Close exactly once, even on failure. Preserve a primary I/O error; otherwise surface
        // late close errors before acknowledging success. Retrying close after EINTR is unsafe.
        let closed = Darwin.close(descriptor)
        switch result {
        case .success(let value): try systemCheck(closed); return value
        case .failure(let error): throw error
        }
    }
    private func forceDirectory(_ url: URL) throws {
        try withDescriptor(Darwin.open(url.path, O_RDONLY)) { descriptor in
            try systemCheck(fsync(descriptor))
        }
    }
    private func makeDirectory(_ url: URL) throws {
        if !FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        }
        // An existing entry might have just been created by another process.
        try forceDirectory(url.deletingLastPathComponent())
    }
    private func locked(_ call: CAPPluginCall, _ body: @escaping (URL) throws -> JSObject) {
        guard let scope = call.getString("scope"), matches(scope, "^[a-f0-9]{64}$") else {
            call.reject("Invalid scope", "INVALID_SCOPE"); return
        }
        Self.io.async {
            do {
                let library = try FileManager.default.url(for: .libraryDirectory, in: .userDomainMask,
                    appropriateFor: nil, create: true)
                let base = library.appendingPathComponent("opengym-nutrition", isDirectory: true)
                try self.makeDirectory(base)
                let directory = base.appendingPathComponent(scope, isDirectory: true)
                try self.makeDirectory(directory)
                let result = try self.withDescriptor(Darwin.open(directory.appendingPathComponent(".lock").path,
                    O_CREAT | O_RDWR, 0o600)) { descriptor in
                    try self.systemCheck(flock(descriptor, LOCK_EX))
                    let outcome: Result<JSObject, Error>
                    do { outcome = .success(try body(directory)) }
                    catch { outcome = .failure(error) }
                    let unlocked = flock(descriptor, LOCK_UN)
                    switch outcome {
                    case .success(let value): try self.systemCheck(unlocked); return value
                    case .failure(let error): throw error
                    }
                }
                call.resolve(result)
            } catch let failure as Failure { call.reject("Nutrition storage failed", failure.code) }
            catch {
                let nativeError = error as NSError
                let full = (nativeError.domain == NSCocoaErrorDomain && nativeError.code == NSFileWriteOutOfSpaceError) ||
                    (nativeError.domain == NSPOSIXErrorDomain && nativeError.code == Int(ENOSPC))
                call.reject("Nutrition storage failed", full ? "QUOTA" : "IO_FAILED", error)
            }
        }
    }
    private func read(_ url: URL) throws -> String? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let length = attributes[.size] as? NSNumber, length.intValue <= maximum else {
            throw Failure(code: "DOCUMENT_TOO_LARGE")
        }
        guard let value = String(data: try Data(contentsOf: url), encoding: .utf8) else { throw Failure(code: "IO_FAILED") }
        return value
    }
    private func atomicWrite(_ directory: URL, _ name: String, _ text: String) throws {
        let bytes = Data(text.utf8)
        guard bytes.count <= maximum else { throw Failure(code: "DOCUMENT_TOO_LARGE") }
        let temporary = directory.appendingPathComponent(UUID().uuidString.lowercased() + ".tmp")
        try withDescriptor(Darwin.open(temporary.path, O_CREAT | O_EXCL | O_WRONLY, 0o600)) { descriptor in
            try bytes.withUnsafeBytes { buffer in
                var offset = 0
                while offset < bytes.count {
                    let count = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), bytes.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    if count <= 0 { throw Failure(code: errno == ENOSPC ? "QUOTA" : "IO_FAILED") }
                    offset += count
                }
            }
            try systemCheck(fsync(descriptor))
            // On Apple systems fsync alone may leave data in the drive's volatile cache.
            try systemCheck(fcntl(descriptor, F_FULLFSYNC))
        }
        // The data descriptor has successfully closed before making its name authoritative.
        try systemCheck(Darwin.rename(temporary.path, directory.appendingPathComponent(name).path))
        try forceDirectory(directory)
    }
    private func nullable(_ call: CAPPluginCall, _ field: String) throws -> String? {
        guard let value = call.options[field] else { throw Failure(code: "INVALID_ARGUMENT") }
        if value is NSNull { return nil }
        guard let text = value as? String else { throw Failure(code: "INVALID_ARGUMENT") }
        return text
    }
    private func manifestKey(_ text: String?) -> String? {
        guard let text = text, let parsed = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
            let value = parsed as? [String: Any],
            let head = value["head"] as? [String: Any], let digest = head["manifestDigest"] as? String,
            matches(digest, "^[a-f0-9]{64}$") else { return nil }
        return "m-" + digest
    }
    private func compareRoots(_ directory: URL, _ call: CAPPluginCall) throws {
        guard try read(directory.appendingPathComponent("root.json")) == nullable(call, "expectedRoot"),
            try read(directory.appendingPathComponent("previous.json")) == nullable(call, "expectedPrevious") else {
            throw Failure(code: "STALE_ROOT")
        }
    }
    @objc func headers(_ call: CAPPluginCall) {
        locked(call) { directory in
            let root = try self.read(directory.appendingPathComponent("root.json"))
            let previous = try self.read(directory.appendingPathComponent("previous.json"))
            var objects: [[String: String]] = [], seen = Set<String>()
            for text in [root, previous] {
                guard let key = self.manifestKey(text), seen.insert(key).inserted else { continue }
                if let text = try self.read(directory.appendingPathComponent(key + ".json")) { objects.append(["key": key, "text": text]) }
            }
            let index = try? self.read(directory.appendingPathComponent("index.json"))
            let hasDocuments = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
                .contains { self.matches($0.lastPathComponent, "^[pm]-[a-f0-9]{64}\\.json$") }
            return ["root": root as Any? ?? NSNull(), "previous": previous as Any? ?? NSNull(),
                "index": index as Any? ?? NSNull(), "objects": objects, "hasDocuments": hasDocuments]
        }
    }
    @objc func readDocuments(_ call: CAPPluginCall) {
        locked(call) { directory in
            try self.compareRoots(directory, call)
            guard let keys = call.getArray("keys") as? [String], keys.count <= 4, Set(keys).count == keys.count else {
                throw Failure(code: "INVALID_ARGUMENT")
            }
            var objects: [[String: String]] = []
            for key in keys {
                guard self.matches(key, "^[pm]-[a-f0-9]{64}$") else { throw Failure(code: "INVALID_KEY") }
                if let text = try self.read(directory.appendingPathComponent(key + ".json")) { objects.append(["key": key, "text": text]) }
            }
            return ["objects": objects]
        }
    }
    @objc func saveIndex(_ call: CAPPluginCall) {
        locked(call) { directory in
            try self.compareRoots(directory, call)
            guard let index = call.getString("index") else { throw Failure(code: "INVALID_ARGUMENT") }
            try self.atomicWrite(directory, "index.json", index)
            return ["saved": true]
        }
    }
    @objc func snapshot(_ call: CAPPluginCall) {
        locked(call) { directory in
            var objects: [[String: String]] = []
            for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
                if self.matches(url.lastPathComponent, "^[pm]-[a-f0-9]{64}\\.json$") {
                    guard let text = try self.read(url) else { throw Failure(code: "IO_FAILED") }
                    objects.append(["key": String(url.lastPathComponent.dropLast(5)), "text": text])
                }
            }
            return ["root": try self.read(directory.appendingPathComponent("root.json")) as Any? ?? NSNull(),
                "previous": try self.read(directory.appendingPathComponent("previous.json")) as Any? ?? NSNull(), "objects": objects]
        }
    }
    @objc func publish(_ call: CAPPluginCall) {
        locked(call) { directory in
            guard let root = call.getString("root"), let writes = call.getArray("writes") as? [[String: String]] else {
                throw Failure(code: "INVALID_ARGUMENT")
            }
            let current = try self.read(directory.appendingPathComponent("root.json"))
            if current == root { return ["repeated": true] }
            guard current == (try self.nullable(call, "expectedRoot")) else { throw Failure(code: "STALE_ROOT") }
            for row in writes {
                guard let key = row["key"], let text = row["text"], self.matches(key, "^[pm]-[a-f0-9]{64}$") else {
                    throw Failure(code: "INVALID_KEY")
                }
                let existing = try self.read(directory.appendingPathComponent(key + ".json"))
                if let existing = existing, existing != text { throw Failure(code: "INTEGRITY_CONFLICT") }
                if existing == nil { try self.atomicWrite(directory, key + ".json", text) }
            }
            if let current = current { try self.atomicWrite(directory, "previous.json", current) }
            try self.atomicWrite(directory, "root.json", root)
            return ["repeated": false]
        }
    }
    @objc func collect(_ call: CAPPluginCall) {
        locked(call) { directory in
            guard try self.read(directory.appendingPathComponent("root.json")) == self.nullable(call, "expectedRoot"),
                try self.read(directory.appendingPathComponent("previous.json")) == self.nullable(call, "expectedPrevious") else {
                throw Failure(code: "STALE_ROOT")
            }
            guard let keys = call.getArray("keys") as? [String] else { throw Failure(code: "INVALID_ARGUMENT") }
            var deleted = 0
            for key in keys {
                guard self.matches(key, "^[pm]-[a-f0-9]{64}$") else { throw Failure(code: "INVALID_KEY") }
                let url = directory.appendingPathComponent(key + ".json")
                if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url); deleted += 1 }
            }
            for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
                if self.matches(url.lastPathComponent, "^[a-f0-9-]{36}\\.tmp$") { try FileManager.default.removeItem(at: url) }
            }
            try self.forceDirectory(directory)
            return ["deleted": deleted]
        }
    }
}

// App-local plugins are not in cap sync's dependency packageClassList. Register explicitly
// after Capacitor loads, retaining automatic registration of every existing package plugin.
@objc(NutritionBridgeViewController)
class NutritionBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NutritionStoragePlugin())
    }
}
