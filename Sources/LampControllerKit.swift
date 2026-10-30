// Lamp's controller kit (Sources/LampRelayKit in Lamp's source, as one file). Written by Lamp before every build; don't edit.
#if os(macOS) || os(iOS)
import Foundation
#if os(macOS)
import SystemConfiguration
#endif

/// Where phones reach a game's controllers, on whichever device the game runs: a Mac, an iPhone or an iPad. Read again
/// at every ask, since the device's addresses change with the network it's on. A phone is only ever given an address
/// on the device's Wi‑Fi or wired network, never a loopback one, which would point the phone at itself.
public enum ControllerAddresses {
    /// The device's IPv4 addresses on its Wi‑Fi and wired networks (the `en` interfaces on a Mac and on an iPhone or
    /// iPad), up and not loopback, the ones a phone on the same network opens: routable ones first, a self-assigned
    /// 169.254 one (a network with no router) last.
    public static func lan() -> [String] {
        var found: [String] = []
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0, let first else { return [] }
        defer { freeifaddrs(first) }
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let entry = pointer.pointee
            let name = String(cString: entry.ifa_name)
            guard name.hasPrefix("en"), let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  entry.ifa_flags & UInt32(IFF_UP) != 0, entry.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                let text = String(cString: host)
                if !found.contains(text) { found.append(text) }
            }
        }
        return found.filter { !$0.hasPrefix("169.254.") } + found.filter { $0.hasPrefix("169.254.") }
    }

    /// The Mac's Bonjour name, as phones may reach it ("name.local"). An iPhone or iPad has no name of its own a game
    /// can read, so its phones are given an address.
    public static func localHostName() -> String? {
        #if os(macOS)
        guard let name = SCDynamicStoreCopyLocalHostName(nil) as String?, !name.isEmpty else { return nil }
        return name + ".local"
        #else
        return nil
        #endif
    }

    /// The names and addresses a phone page is served as: the device's on its networks, and the loopback ones.
    public static func names() -> Set<String> {
        var names: Set<String> = ["127.0.0.1", "localhost", "::1"]
        if let name = localHostName() { names.insert(name.lowercased()) }
        for address in lan() { names.insert(address.lowercased()) }
        return names
    }

    /// The host a phone's link carries: the first network address, else the Mac's Bonjour name; nil when the device is
    /// on no network a phone could share, which is said rather than handing out a link that can't work.
    public static func linkHost() -> String? { lan().first ?? localHostName() }
}

import CryptoKit
import Foundation

/// One game's phones as controllers, run by the game itself on the Mac, an iPhone or an iPad: its phone page, served from the copy Lamp put
/// in the game's bundle (`PhonePageServer`), and the relay its phones and its page meet at (`Relay`), both in the
/// game's own process, each on a port the system gives it free. The game's page asks for its session (`/app/controller`,
/// which the app around the page answers from here) as `Lamp.controllers` starts and every few seconds after; the first
/// ask opens both, and `stop` (the page stopping its controllers, or the game quitting) closes them. Lamp has no part in
/// it, so a game's phones go on playing, and new ones join, whether Lamp is open or not.
///
/// The credentials are signed with a key made for each session and kept only in this object's memory: never in the
/// page's files, its JavaScript, the link a phone opens or the bundle. A session that stops and starts again has a new
/// key, so nothing handed out before gets in.
///
/// Lamp builds this file into its own relay (LampRelayKit), where the tests reach it, and into every game on the Mac,
/// the iPhone and the iPad (`GameKit.controllerKit`), where LampPage.swift runs it.
public final class ControllerRuntime: @unchecked Sendable {
    public let app: String
    private let root: URL
    private let queue = DispatchQueue(label: "dev.lamp.controllers")
    private var key: SymmetricKey?
    private var relay: Relay?
    private var relayPort: UInt16?
    private var site: PhonePageServer?
    /// The device's names and addresses, and the host a phone's link carries (nil: on no network a phone can share).
    /// Changed by tests.
    public var hosts: @Sendable () -> Set<String> = { ControllerAddresses.names() }
    public var linkHost: @Sendable () -> String? = { ControllerAddresses.linkHost() }

    /// How often the page asks again, which tells the relay where the page is now (the device's address moves with the network).
    public static let renew = 15

    /// `root`: the game's phone page, as Lamp put it in the bundle.
    public init(app: String, page root: URL) {
        self.app = app
        self.root = root
    }

    /// The game's session, opened if it isn't: what `/app/controller` answers, with its status. On the runtime's own
    /// queue, never the caller's, since opening waits for the system to give each listener its port.
    public func start(_ done: @escaping @Sendable (_ status: Int, _ answer: [String: Any]) -> Void) {
        queue.async { let (status, answer) = self.open(); done(status, answer) }
    }

    /// The same, waiting for it: for tests.
    public func startNow() -> (status: Int, answer: [String: Any]) { queue.sync { open() } }

    /// Closes the page and the relay: every phone and the page's own socket are let go, and the key is forgotten. On the
    /// same queue as `start`, so a stop and the start after it (a game's next round) happen in the order they were asked.
    public func stop(_ done: @escaping @Sendable () -> Void) {
        queue.async { self.close(); done() }
    }

    /// The same, waiting for it: for tests.
    public func stop() { queue.sync { close() } }

    public var pagePort: UInt16? { queue.sync { site?.port } }
    public var isRunning: Bool { queue.sync { relay != nil || site != nil } }

    private func open() -> (Int, [String: Any]) {
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path) else {
            return (409, ["error": "The game has no phone page yet: put one in Phone/index.html."])
        }
        // Never a loopback link: a phone opening it would reach itself. The page's next ask tries again, once the device
        // is back on a network.
        guard let link = linkHost() else {
            close()
            return (503, ["error": "This device isn't on a Wi‑Fi network phones can join. Join one, and phones can play again."])
        }
        let key = self.key ?? SymmetricKey(size: .bits256)
        self.key = key
        guard let relayPort = openRelay(key) else {
            close()
            return (503, ["error": "The link for phones couldn't open on this Mac."])
        }
        if site == nil { openSite() }
        guard let site, let pagePort = site.port else {
            close()
            return (503, ["error": "The phone page couldn't open on this Mac."])
        }
        relay?.configure(app: app, Relay.Session(generation: 0, pagePort: pagePort, page: Self.address(link, pagePort),
                                                 hosts: Array(hosts()).sorted()))
        let credential = ControllerToken.issue(kind: .host, app: app, generation: 0, key: key)
        return (200, ["links": [["kind": "relay", "socket": "ws://127.0.0.1:\(relayPort)/", "app": app, "credential": credential]],
                      "renew": Self.renew])
    }

    /// A page's address at `host`, an IPv6 one in brackets.
    static func address(_ host: String, _ port: UInt16) -> String {
        "http://\(host.contains(":") ? "[\(host)]" : host):\(port)/"
    }

    private func close() {
        relay?.stop()
        relay = nil
        relayPort = nil
        share(nil)
        site?.stop()
        site = nil
        key = nil
    }

    /// The relay, on a port the system gives it, started when the session first needs it.
    private func openRelay(_ key: SymmetricKey) -> UInt16? {
        if let relayPort, relay != nil { return relayPort }
        let started = Relay(key: key)
        let ready = DispatchSemaphore(value: 0)
        let port = Said<UInt16>()
        started.onStopped = { [weak self, weak started] in
            self?.queue.async {
                // The network went away under it: the page's next ask opens the session afresh.
                guard let self, self.relay === started else { return }
                self.close()
            }
        }
        started.start(port: 0) { given in
            port.value = given
            ready.signal()
        }
        guard ready.wait(timeout: .now() + 5) == .success, let given = port.value else { started.stop(); return nil }
        relay = started
        relayPort = given
        share(given)
        return given
    }

    private func openSite() {
        let site = PhonePageServer(port: 0, root: root, app: app, hosts: hosts, relayPort: { [weak self] in self?.currentRelayPort })
        let ready = DispatchSemaphore(value: 0)
        let listening = Said<Bool>()
        site.start(ready: { ok in listening.value = ok; ready.signal() }, onFailure: { [weak self, weak site] in
            self?.queue.async {
                // It stopped listening (the network went away under it): the page's next ask opens it again.
                guard let self, let site, self.site === site else { return }
                self.site = nil
            }
        })
        guard ready.wait(timeout: .now() + 5) == .success, listening.value == true else { site.stop(); return }
        self.site = site
    }

    /// Read by the page server from its own queue, so it never waits on this one.
    private let portLock = NSLock()
    private var sharedRelayPort: UInt16?
    private var currentRelayPort: UInt16? { portLock.withLock { sharedRelayPort } }
    private func share(_ port: UInt16?) { portLock.withLock { sharedRelayPort = port } }
}

/// What a callback on another queue says, read after a semaphore says it has.
private final class Said<Value>: @unchecked Sendable {
    var value: Value?
}

import CryptoKit
import Foundation

/// A game's phone page as Lamp hands it to the controllers' service (`ControllerService`): every file of the page as
/// Lamp published it, by its path inside the page, with Lamp's own lamp-controller.js among them. The service keeps
/// each version it's given in a folder of its own and serves only from there, never from the game's folder, which the
/// agent goes on changing; a game is bound to the version it was built with, so a new build never changes the page
/// under a game that's still being played. The same rules as Lamp's own serving: no hidden names, no links, plain files
/// of a size a page has.
public struct ControllerSnapshot: Equatable, Sendable {
    public struct File: Equatable, Sendable {
        public let path: String
        public let data: Data
        public init(path: String, data: Data) {
            self.path = path
            self.data = data
        }
    }

    public let files: [File]
    public init(files: [File]) { self.files = files.sorted { $0.path < $1.path } }

    /// The largest file served, as Lamp serves a page (`TVs.phoneFile`), and the most a page may hold in all.
    public static let fileLimit = 64 << 20
    public static let totalLimit = 256 << 20
    public static let countLimit = 4000

    public struct Failure: Error, Equatable, CustomStringConvertible {
        public let description: String
        public init(_ description: String) { self.description = description }
    }

    /// Whether a path inside a page is one served: steps of a name each, none hidden, empty or stepping up.
    public static func isServed(_ path: String) -> Bool {
        guard !path.isEmpty, path.utf8.count <= 1024, !path.contains("\0"), !path.contains("\\") else { return false }
        let steps = path.split(separator: "/", omittingEmptySubsequences: false)
        return steps.allSatisfy { !$0.isEmpty && !$0.hasPrefix(".") && $0.utf8.count <= 255 }
    }

    /// The page's checks: each path served, no two the same, sizes within limits, and an index.html to open.
    public func check() throws {
        guard files.count <= Self.countLimit else { throw Failure("The phone page has too many files.") }
        var seen: Set<String> = []
        var total = 0
        for file in files {
            guard Self.isServed(file.path) else { throw Failure("The phone page has a file that can't be served: \(file.path)") }
            guard seen.insert(file.path).inserted else { throw Failure("The phone page names \(file.path) twice.") }
            guard file.data.count <= Self.fileLimit else { throw Failure("\(file.path) is too large for a phone page.") }
            total += file.data.count
        }
        guard total <= Self.totalLimit else { throw Failure("The phone page is too large.") }
        guard seen.contains("index.html") else { throw Failure("The phone page has no index.html.") }
    }

    /// What this version of the page is, from every file's path and bytes: the same page has the same digest.
    public var digest: String {
        var hash = SHA256()
        for file in files {
            hash.update(data: Data(file.path.utf8))
            hash.update(data: Data([0]))
            hash.update(data: Data(String(file.data.count).utf8))
            hash.update(data: Data([0]))
            hash.update(data: file.data)
        }
        return Data(hash.finalize()).urlSafeBase64
    }

    /// A version's name from its digest: short enough for a folder and an Info.plist, unique enough for one game.
    public var version: String { String(digest.prefix(24)) }

    /// The page in `folder`, read as it's served: hidden files left out, as they're never served; a link anywhere, or a
    /// file too large, and there's no page.
    public static func read(_ folder: URL) throws -> ControllerSnapshot {
        let fm = FileManager.default
        let root = folder.standardizedFileURL
        guard (try? root.resourceValues(forKeys: [.isSymbolicLinkKey]))?.isSymbolicLink == false else { throw Failure("The phone page is a link.") }
        let keys: [URLResourceKey] = [.isSymbolicLinkKey, .isRegularFileKey, .isDirectoryKey, .fileSizeKey]
        guard let walk = fm.enumerator(at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
            throw Failure("The phone page couldn't be read.")
        }
        var files: [File] = []
        for case let url as URL in walk {
            let values = try url.resourceValues(forKeys: Set(keys))
            if values.isSymbolicLink == true { throw Failure("The phone page has a link: \(url.lastPathComponent)") }
            if values.isDirectory == true { continue }
            guard values.isRegularFile == true else { continue }
            guard (values.fileSize ?? 0) <= fileLimit else { throw Failure("\(url.lastPathComponent) is too large for a phone page.") }
            let path = String(url.standardizedFileURL.path.dropFirst(root.path.count + 1))
            guard isServed(path) else { continue }
            files.append(File(path: path, data: try Data(contentsOf: url)))
        }
        return ControllerSnapshot(files: files)
    }

    /// The page as it crosses to the service, and back.
    public var encoded: [[String: Any]] { files.map { ["path": $0.path, "data": $0.data.base64EncodedString()] } }

    public init(encoded: [[String: Any]]) throws {
        var files: [File] = []
        for each in encoded {
            guard let path = each["path"] as? String, let data = (each["data"] as? String).flatMap({ Data(base64Encoded: $0) }) else {
                throw Failure("The phone page arrived damaged.")
            }
            files.append(File(path: path, data: data))
        }
        self.init(files: files)
    }

    /// Writes the page into `folder`, which mustn't exist yet: made beside it and moved into place whole, so a page is
    /// served whole or not at all.
    public func write(to folder: URL) throws {
        try check()
        let fm = FileManager.default
        let partial = folder.deletingLastPathComponent().appendingPathComponent(".partial-" + UUID().uuidString)
        try fm.createDirectory(at: partial, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: partial) }
        for file in files {
            let url = partial.appendingPathComponent(file.path)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try file.data.write(to: url)
        }
        try fm.moveItem(at: partial, to: folder)
    }
}

import CryptoKit
import Foundation

/// A controller's credential as it's written and checked: a short signed token for one kind of holder in one app's
/// session, signed with a key that lives only in memory. Lamp signs them (`ControllerCredential`), and so does the relay
/// (`Relay`), which Lamp gives the same key when it starts it; a wish's iPhone app checks the ones made with the key Lamp
/// gave it for its own listener (`LampController` in LampSupport writes the same form).
///
///   host        the TV app's page, for its socket, for as long as a session may last.
///   join        what a phone's link carries, after the #, which a browser never sends: for fifteen minutes.
///   controller  given to a phone once it has joined: its place, for two minutes, renewed while it stays, so a phone that
///               drops off comes back as the same player.
///
/// A wish's own apps need none of these: they get into their wish's room by proving they hold the wish's key (`WishChannel`).
public enum ControllerToken {
    public enum Kind: String, CaseIterable, Sendable {
        case host, join, controller
        public var lifetime: TimeInterval {
            switch self {
            case .host: 12 * 3600
            case .join: 15 * 60
            case .controller: 2 * 60
            }
        }
    }

    public struct Claim: Equatable, Sendable {
        public let kind: Kind
        public let app: String
        public let player: Int?
        /// A host's: the TV preview on the Mac, which keeps its game from a TV that runs the same app meanwhile.
        public let preview: Bool
        public init(kind: Kind, app: String, player: Int?, preview: Bool) {
            self.kind = kind
            self.app = app
            self.player = player
            self.preview = preview
        }
    }

    public static func issue(kind: Kind, app: String, generation: Int, player: Int? = nil, preview: Bool = false,
                             lifetime: TimeInterval? = nil, now: Date = Date(), key: SymmetricKey) -> String {
        var payload: [String: Any] = ["k": kind.rawValue, "a": app, "g": generation,
                                      "e": Int(now.addingTimeInterval(lifetime ?? kind.lifetime).timeIntervalSince1970),
                                      "n": Data((0..<9).map { _ in UInt8.random(in: 0...255) }).urlSafeBase64]
        if let player { payload["p"] = player }
        if preview { payload["v"] = 1 }
        let body = ((try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()).urlSafeBase64
        return body + "." + Data(HMAC<SHA256>.authenticationCode(for: Data(body.utf8), using: key)).urlSafeBase64
    }

    /// What a credential says when it was made with this key, for this app in this generation of its session, of one of
    /// these kinds, and it hasn't run out; nil otherwise, whatever is wrong with it.
    public static func check(_ token: String?, kinds: Set<Kind>, app: String, generation: Int, now: Date = Date(),
                             key: SymmetricKey) -> Claim? {
        guard let token, token.utf8.count <= 1024 else { return nil }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, let signature = Data(urlSafeBase64: String(parts[1])),
              HMAC<SHA256>.isValidAuthenticationCode(signature, authenticating: Data(parts[0].utf8), using: key),
              let body = Data(urlSafeBase64: String(parts[0])),
              let payload = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let kind = (payload["k"] as? String).flatMap(Kind.init(rawValue:)), kinds.contains(kind),
              payload["a"] as? String == app, payload["g"] as? Int == generation,
              let expires = payload["e"] as? Int, Double(expires) > now.timeIntervalSince1970 else { return nil }
        return Claim(kind: kind, app: app, player: payload["p"] as? Int, preview: payload["v"] as? Int == 1)
    }
}

extension Data {
    public var urlSafeBase64: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    public init?(urlSafeBase64 text: String) {
        guard text.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) else { return nil }
        var plain = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        plain += String(repeating: "=", count: (4 - plain.count % 4) % 4)
        self.init(base64Encoded: plain)
    }
}

import Foundation

/// What a page shared with this person may reach: its own files, and the exact sites (scheme, host and port) the safety
/// sheet named when it arrived, read from its code (`WebReach`, `SharedNetwork` in Lamp). Lamp keeps it in its own folder,
/// outside the app's, and writes it into every build of the app (Info.plist's `LampNetwork`), so it holds with Lamp
/// closed and neither the page's code, a rebuild nor a live change can widen it. Swift of the sender's in the app
/// (`ownSwift`) can: it runs in the app's own process, where it can reach the network itself and switch the page's
/// guard off (the person's choices are kept in the app's defaults), so such an app isn't held at all, its page
/// included, and its sheet says "Has Swift that can reach any site". An app the person made has none and reaches what
/// it likes.
///
/// One rule for every host of a shared page, each reading this type rather than a copy of it: the app around it on the
/// Mac, the iPhone and the iPad (LampPage.swift, as Content-Security-Policy headers and its navigation) and Lamp's
/// previews (`StagedFiles`) do; a host elsewhere (a TV, an Xbox, Android, a phone's controller page) holds a shared page
/// only once it reads it too. It's in LampRelayKit because that's the Swift Lamp and every page's app compile alike
/// (the controller kit).
public struct NetworkPolicy: Codable, Equatable, Sendable {
    /// Exact origins, as `origin(_:)` writes them: "https://api.open-meteo.com", "wss://relay.example:8443".
    public var origins: [String]
    /// The sheet said the app may connect outside itself (a request whose address Lamp couldn't work out): a request it
    /// blocks is shown to the person, who can allow that one site.
    public var mayConnect: Bool
    /// The app carries Swift of the sender's beside the page (any of Sources/ but Lamp's own Native.swift): it runs in
    /// the app's process, where it can reach the network itself and turn the page's guard off, so the app isn't held to
    /// these sites, its page included.
    public var ownSwift: Bool
    /// The person chose to let it reach any site, for good.
    public var unrestricted: Bool

    public init(origins: [String] = [], mayConnect: Bool = false, ownSwift: Bool = false, unrestricted: Bool = false) {
        self.origins = Array(Set(origins.compactMap(Self.origin))).sorted()
        self.mayConnect = mayConnect
        self.ownSwift = ownSwift
        self.unrestricted = unrestricted
    }

    /// Whether the page is held to its sites: a shared app the person hasn't let reach every site.
    public var restricts: Bool { !unrestricted }

    /// The site an address is on, as a policy names it: the scheme, the host lowercased, and the port when it isn't the
    /// scheme's own. Only the web's schemes (http, https, ws, wss) are sites; anything else is nil.
    public static func origin(_ text: String) -> String? {
        guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(), !host.isEmpty,
              let standard = ["http": 80, "https": 443, "ws": 80, "wss": 443][scheme] else { return nil }
        // A host is letters, digits, dots and dashes (or an IPv6 address in brackets): nothing that could end a policy's
        // source list early.
        let bare = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
        guard bare.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || ".-:".contains($0)) }) else { return nil }
        let shown = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        return scheme + "://" + shown + (parts.port.map { $0 == standard ? "" : ":\($0)" } ?? "")
    }

    public static func origin(of url: URL) -> String? { origin(url.absoluteString) }

    /// Whether a request to `url` may go: a page's own address (`own`, its scheme and host), a page's own data (data:,
    /// blob:, about:), or one of its sites. `extra` are sites the person allowed on this device.
    public func allows(_ url: URL, own: String, extra: [String] = []) -> Bool {
        if unrestricted { return true }
        let scheme = url.scheme?.lowercased() ?? ""
        if ["data", "blob", "about"].contains(scheme) { return true }
        if let ownURL = URL(string: own), scheme == ownURL.scheme?.lowercased(), url.host?.lowercased() == ownURL.host?.lowercased() { return true }
        guard let site = Self.origin(of: url) else { return false }
        return (origins + extra.compactMap(Self.origin)).contains(site)
    }

    /// Whether a page may be shown in a frame of the page, or the page itself go there: only the page's own address and
    /// what it makes for itself (blob: and about:). A site the page may fetch from is still never a frame of it, since
    /// a page from there would run with none of these rules.
    public func allowsFrame(_ url: URL, own: String) -> Bool {
        if unrestricted { return true }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "blob" || scheme == "about" { return true }
        guard let ownURL = URL(string: own) else { return false }
        return scheme == ownURL.scheme?.lowercased() && url.host?.lowercased() == ownURL.host?.lowercased()
    }

    /// The Content-Security-Policy every document and worker of the page is served with, for a page at `own`
    /// ("lamp-web-app://app"), nil when it isn't restricted. Nothing is allowed that isn't named: the page's own files and
    /// its sites for what it loads and connects to; its inline code and eval (Lamp's review reads those, and they're held
    /// to the same sites); data: and blob: for what it makes itself; frames and workers only from itself. Forms post only
    /// to itself, and plugins never run. A site's scheme is as exact as CSP makes it: a ws: site lets that host and port's
    /// http: through too, and an http: site its https: (CSP's own matching), never another host or port. `connect` are
    /// sites the page may only connect to, never load from, and only while its host says so: Lamp's own controllers relay
    /// in its TV preview, at whichever port it listens on now. They're never the page's sites, so never kept as them.
    public func contentSecurityPolicy(own: String, extra: [String] = [], connect: [String] = []) -> String? {
        guard restricts else { return nil }
        let sites = Array(Set(origins + extra.compactMap(Self.origin))).sorted()
        let me = "'self' " + own
        let reach = ([me] + sites).joined(separator: " ")
        let connecting = ([reach] + Array(Set(connect.compactMap(Self.origin)).subtracting(sites)).sorted()).joined(separator: " ")
        return [
            "default-src \(me)",
            "script-src \(reach) 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
            "style-src \(reach) 'unsafe-inline' data: blob:",
            "img-src \(reach) data: blob:",
            "media-src \(reach) data: blob:",
            "font-src \(reach) data: blob:",
            "connect-src \(connecting) data: blob:",
            "worker-src \(me) blob:",
            "child-src \(me) blob:",
            "frame-src \(me) blob:",
            "manifest-src \(me)",
            "object-src 'none'",
            "base-uri \(me)",
            "form-action \(me)",
        ].joined(separator: "; ")
    }

    // MARK: In the app's Info.plist

    /// The policy as the app's Info.plist carries it under `LampNetwork`.
    public static let plistKey = "LampNetwork"

    /// The policy's lines in an Info.plist (`<key>LampNetwork</key><dict>…</dict>`).
    public var plistLines: String {
        func flag(_ value: Bool) -> String { value ? "<true/>" : "<false/>" }
        let sites = origins.map { "<string>\(Self.escaped($0))</string>" }.joined()
        return "  <key>\(Self.plistKey)</key><dict><key>origins</key><array>\(sites)</array>"
            + "<key>mayConnect</key>\(flag(mayConnect))<key>ownSwift</key>\(flag(ownSwift))<key>unrestricted</key>\(flag(unrestricted))</dict>"
    }

    /// The policy an app's Info.plist carries, or nil when it has none (an app the person made).
    public init?(plist value: Any?) {
        guard let dict = value as? [String: Any] else { return nil }
        self.init(origins: dict["origins"] as? [String] ?? [], mayConnect: dict["mayConnect"] as? Bool ?? false,
                  ownSwift: dict["ownSwift"] as? Bool ?? false, unrestricted: dict["unrestricted"] as? Bool ?? false)
    }

    private static func escaped(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
}

#if canImport(WebKit)
import WebKit

extension NetworkPolicy {
    /// What WebKit reaches out to on a page's behalf that no Content-Security-Policy covers, turned off for a page held to
    /// its sites: WebRTC (its STUN and TURN servers are whichever the page names), and a link's preconnect and prefetch,
    /// which look up a name and open a connection whose name, in the lookup and the TLS hello, is whatever the page
    /// spells. WebKit's switches for these aren't public: each is asked for by its name, and only where it's there.
    /// Returns the ones turned off. Call it before the web view is made.
    @MainActor @discardableResult
    public static func holdBack(_ preferences: WKPreferences) -> [String] {
        let off: Set<String> = ["PeerConnectionEnabled", "LinkPreconnect", "LinkPreconnectEarlyHintsEnabled",
                                "LinkPrefetchEnabled", "SpeculationRulesPrefetchEnabled"]
        let list = NSSelectorFromString("_features"), set = NSSelectorFromString("_setEnabled:forFeature:")
        let type: AnyObject = WKPreferences.self
        guard type.responds(to: list), preferences.responds(to: set),
              let features = type.perform(list)?.takeUnretainedValue() as? [NSObject] else { return [] }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        let setEnabled = unsafeBitCast(preferences.method(for: set), to: Setter.self)
        var done: [String] = []
        for feature in features {
            guard let key = feature.value(forKey: "key") as? String, off.contains(key) else { continue }
            setEnabled(preferences, set, false, feature)
            done.append(key)
        }
        return done.sorted()
    }
}
#endif

import Foundation
import Network

/// One game's phone page, served by the game itself (`ControllerRuntime`) on a port of its own, as Lamp serves a TV
/// app's page (`PhoneSites`): each game's page is an origin of its own in a phone's browser. Plain GETs of the files of
/// the page Lamp put in the game's bundle (`ControllerSnapshot`), from a phone on the network by one of the device's names
/// or addresses, or on the device by a loopback name; and `lamp-relay.json`, where lamp-controller.js opens its socket.
public final class PhonePageServer: @unchecked Sendable {
    /// The port asked for (0: any the system gives), then the one it listens on once it does.
    public private(set) var port: UInt16?
    private let root: URL
    private let app: String
    private let queue = DispatchQueue(label: "dev.lamp.controllers.page")
    private var listener: NWListener?
    /// Connections open now, by the address they came from: a page is a few small requests, so a host that holds many
    /// open, or one that never finishes its request, is let go before it can use up what the game needs for phones.
    private var open: [ObjectIdentifier: String] = [:]
    public static let connectionLimit = (all: 64, each: 16)
    public static let headDeadline: TimeInterval = 10
    /// The names and addresses the device answers as, lowercased, read when asked: they change with the network.
    private let hosts: @Sendable () -> Set<String>
    private let relayPort: @Sendable () -> UInt16?

    public init(port: UInt16 = 0, root: URL, app: String, hosts: @escaping @Sendable () -> Set<String>, relayPort: @escaping @Sendable () -> UInt16?) {
        self.port = port
        self.root = root
        self.app = app
        self.hosts = hosts
        self.relayPort = relayPort
    }

    /// Starts listening on every interface at its port; `ready` hears true once it does (and `port` says where), false
    /// when another program has the port. `onFailure`: it stopped listening afterwards.
    public func start(ready: @escaping @Sendable (Bool) -> Void, onFailure: @escaping @Sendable () -> Void = {}) {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = false
        let asked = port ?? 0
        guard let listener = try? NWListener(using: params, on: asked == 0 ? .any : (NWEndpoint.Port(rawValue: asked) ?? .any)) else { return ready(false) }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return connection.cancel() }
            var from = "?"
            if case .hostPort(let host, _) = connection.endpoint { from = "\(host)" }
            let id = ObjectIdentifier(connection)
            guard self.open.count < Self.connectionLimit.all, self.open.values.filter({ $0 == from }).count < Self.connectionLimit.each else {
                return connection.cancel()
            }
            self.open[id] = from
            connection.stateUpdateHandler = { [weak self] state in
                switch state {
                case .failed, .cancelled: self?.open[id] = nil
                default: break
                }
            }
            connection.start(queue: self.queue)
            self.queue.asyncAfter(deadline: .now() + Self.headDeadline) { [weak self, weak connection] in
                guard let connection, let from = self?.open[id], from != "answered" else { return }
                connection.cancel()
            }
            self.receive(connection, buffer: Data())
        }
        var answered = false
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self else { return }
            switch state {
            case .ready:
                if !answered { answered = true; self.port = listener?.port?.rawValue; ready(true) }
            case .failed, .cancelled:
                if !answered { answered = true; ready(false) } else { onFailure() }
                listener?.stateUpdateHandler = nil
                listener?.newConnectionHandler = nil
                listener?.cancel()
            default:
                break
            }
        }
        queue.sync { self.listener = listener }
        listener.start(queue: queue)
    }

    public func stop() {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
        }
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 14) { [weak self] data, _, done, error in
            guard let self else { return connection.cancel() }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
                let page = self.answer(head)
                // Answered: the deadline is for the request, not for a phone on a slow network taking the page.
                self.open[ObjectIdentifier(connection)] = "answered"
                Self.respond(connection, page)
            } else if done || error != nil || buffer.count > 16 << 10 {
                connection.cancel()
            } else {
                self.receive(connection, buffer: buffer)
            }
        }
    }

    public struct Page: Equatable {
        public var status: Int
        public var type = "text/plain; charset=utf-8"
        public var body = Data()
        public var location: String?
        public var head = false
    }

    /// The answer to a request's head (its request line and headers).
    public func answer(_ head: String) -> Page {
        var lines = head.components(separatedBy: "\r\n")
        let start = lines.removeFirst().split(separator: " ")
        guard start.count >= 2 else { return Page(status: 400, body: Data("Bad request".utf8)) }
        let method = String(start[0])
        guard method == "GET" || method == "HEAD" else { return Page(status: 405, body: Data("Not allowed".utf8)) }
        var host: String?
        for line in lines {
            guard let colon = line.firstIndex(of: ":"), line[..<colon].lowercased() == "host" else { continue }
            host = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        var page = answer(path: String(start[1]), host: host)
        page.head = method == "HEAD"
        return page
    }

    /// A page by its path, asked for by `host`: only this device by one of its names, so a page elsewhere that made its own
    /// name lead here (DNS rebinding) reads nothing.
    public func answer(path full: String, host: String?) -> Page {
        guard Self.names(host, among: hosts()) else { return Page(status: 403, body: Data("Not for this host.".utf8)) }
        let missing = Page(status: 404, body: Data("Nothing here. Open the game first.".utf8))
        let path = full.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        guard path.hasPrefix("/") else { return missing }
        var names = path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map { $0.removingPercentEncoding ?? "\0" }
        if names.last == "" { names[names.count - 1] = "index.html" }
        if names == ["lamp-relay.json"] {
            guard let port = relayPort(),
                  let body = try? JSONSerialization.data(withJSONObject: ["port": Int(port), "app": app]) else {
                return Page(status: 503, body: Data("The link for controllers isn't open.".utf8))
            }
            return Page(status: 200, type: Self.type(for: "json"), body: body)
        }
        let relative = names.joined(separator: "/")
        guard names.allSatisfy({ !$0.contains("/") }), ControllerSnapshot.isServed(relative) else { return missing }
        var steps = [root]
        for name in names { steps.append(steps[steps.count - 1].appendingPathComponent(name)) }
        guard steps.allSatisfy({ (try? $0.resourceValues(forKeys: [.isSymbolicLinkKey]))?.isSymbolicLink == false }) else { return missing }
        let file = steps[steps.count - 1]
        let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values?.isRegularFile == true, (values?.fileSize ?? 0) <= ControllerSnapshot.fileLimit,
              let data = try? Data(contentsOf: file) else { return missing }
        return Page(status: 200, type: Self.type(for: file.pathExtension), body: data)
    }

    /// Whether a Host header names one of `hosts`, with at most a numeric port after it.
    public static func names(_ header: String?, among hosts: Set<String>) -> Bool {
        guard var host = header?.trimmingCharacters(in: .whitespaces).lowercased(), !host.isEmpty else { return false }
        if host.hasPrefix("[") {
            guard let close = host.firstIndex(of: "]") else { return false }
            let port = host[host.index(after: close)...]
            guard port.isEmpty || (port.hasPrefix(":") && port.count > 1 && port.dropFirst().allSatisfy(\.isNumber)) else { return false }
            host = String(host[host.index(after: host.startIndex)..<close])
        } else if let colon = host.firstIndex(of: ":") {
            let port = host[host.index(after: colon)...]
            guard !port.isEmpty, port.allSatisfy(\.isNumber) else { return false }
            host = String(host[..<colon])
        }
        return hosts.contains(host)
    }

    private static func respond(_ connection: NWConnection, _ page: Page) {
        let reason = HTTPURLResponse.localizedString(forStatusCode: page.status).capitalized
        let location = page.location.map { "Location: \($0)\r\n" } ?? ""
        var response = Data(("HTTP/1.1 \(page.status) \(reason)\r\nContent-Type: \(page.type)\r\nContent-Length: \(page.body.count)\r\n\(location)"
            + "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n").utf8)
        if !page.head { response.append(page.body) }
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }

    /// The type a page's file is served as, by its extension: Lamp's own serving reads the same list (`Store.pageType`).
    public static func type(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": "text/html; charset=utf-8"
        case "js", "mjs": "text/javascript; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "json", "webmanifest": "application/json"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "webp": "image/webp"
        case "ico": "image/x-icon"
        case "woff2": "font/woff2"
        case "woff": "font/woff"
        case "mp3": "audio/mpeg"
        case "wav": "audio/wav"
        case "mp4": "video/mp4"
        case "txt": "text/plain; charset=utf-8"
        default: "application/octet-stream"
        }
    }

    /// The device's addresses on its Wi‑Fi and wired networks (`ControllerAddresses.lan`).
    public static func localAddresses() -> [String] { ControllerAddresses.lan() }
}

import CryptoKit
import Foundation
import Network

/// Phones and a TV app's page talking to each other, in a process of Lamp's own (`LampRelay`, which Lamp starts while a
/// TV app takes players), never in Lamp's: a phone's page, a wish's Mac app, and the TV app's page (in the preview or on
/// the TV) each open a WebSocket here, and the relay passes what they say on, on a queue of its own. Lamp only opens and
/// ends each app's session (`configure`, `end`) and hands out the credentials that let each one in, signed with the key
/// it gave the relay; the relay makes the ones a session goes on to need (a link's, a phone's renewal) with the same key.
///
/// Each running TV app is one session: one host (its page) and up to eight phones, each at a place (1…8) the TV page
/// numbers as it likes (`player` messages). Phones send buttons, sticks and messages to the host, and files both ways,
/// in pieces with their own flow control (`ControllerWire`). The relay keeps nothing once it's passed on, holds every
/// file to the size it was announced at and to a window ahead of what's been acknowledged, and lets go of anything
/// that doesn't keep to that.
///
/// Beside the games, a **room** for each wish of more than one app (`configureRoom`, with the wish's key): the wish's
/// apps join it as peers by proving they hold the key, over a handshake that sends nothing anyone could use again
/// (`WishChannel`), and everything after it is sealed, so what they say crosses the network unreadable. A peer names
/// which app it is in its hello, hears who else is in the room (`welcome`, `joined`, `left`) and sends JSON messages to
/// one peer or to all (`send` → `message`) and the values they share to one peer (`values`), under the same size and
/// rate limits as a phone's; it keeps no values itself. What the copies share in collections (`LampStore.shared`) Lamp
/// keeps, as a member under the relay's own name (`WishKeeper`), when Lamp gives the room a folder for it. Files go to one peer in pieces (`WishChannel.piece`) under the
/// controllers' flow (`ControllerWire`: a window ahead of what's acknowledged, two at once each way between two apps),
/// and a game's controls from a wish's app to its TV app's `Lamp.controllers` as `pad` messages; both only to an app
/// that speaks 3 or more, since an earlier one would take a piece for a message gone wrong. The relay tells whoever
/// runs it who is in each room (`onRoomChanged`), so Lamp can say so to the builder.
public final class Relay: @unchecked Sendable {
    public struct Session: Equatable, Sendable {
        /// Lamp's generation of the app's session: credentials of an earlier one get nowhere.
        public var generation: Int
        /// The port the app's phone page is served at, and the address phones open (`link`), when it has one.
        public var pagePort: UInt16?
        public var page: String?
        /// The names and addresses the page is served as (this Mac's), lowercased: the only pages let in.
        public var hosts: [String]
        public init(generation: Int, pagePort: UInt16?, page: String?, hosts: [String]) {
            self.generation = generation
            self.pagePort = pagePort
            self.page = page
            self.hosts = hosts
        }
    }

    final class Transfer {
        let size: Int
        var passed = 0
        var acknowledged = 0
        /// Pieces passed that haven't been acknowledged yet: an acknowledgement goes on only for one, so a receiver
        /// can't flood the sender with them.
        var unacknowledged = 0
        init(size: Int) { self.size = size }

        /// Whether an acknowledgement is one to pass on: it's for more than the last, no more than has been passed, and
        /// for a piece not yet acknowledged (or the end of an empty file). False for anything else, which is dropped.
        func acknowledge(_ got: Int) -> Bool {
            if size == 0, got == 0, acknowledged == 0, unacknowledged == 0 { unacknowledged = -1; return true }
            guard got > acknowledged, got <= passed, unacknowledged > 0 else { return false }
            acknowledged = got
            unacknowledged -= 1
            return true
        }
    }

    /// How often one socket may send: about as often as a screen draws. Past that its messages are dropped, and one
    /// that goes on past it for ten seconds is let go.
    final class Rate {
        var tokens = ControllerWire.perSecond
        var refilled = Date()
        /// Since when it has gone on past its rate, with no more than a moment's pause, and when it last did.
        var over: Date?
        var lastDropped = Date.distantPast

        func allowed(_ peer: RelayPeer?) -> Bool {
            let now = Date()
            tokens = min(ControllerWire.perSecond, tokens + now.timeIntervalSince(refilled) * ControllerWire.perSecond)
            refilled = now
            // A pause of a couple of seconds ends the stretch: a flood that lets one message through now and then still counts.
            if now.timeIntervalSince(lastDropped) > 2 { over = nil }
            if tokens >= 1 { tokens -= 1; return true }
            lastDropped = now
            if over == nil { over = now }
            if let over, now.timeIntervalSince(over) > 10 { peer?.close(code: 4008) }
            return false
        }
    }

    final class Player {
        var peer: RelayPeer?
        /// While a phone that dropped off may still come back with its credential, its place stays its own.
        var heldUntil = Date.distantPast
        let rate = Rate()
        /// Files on their way from the phone to the host, and from the host to the phone, by the sender's id.
        var toHost: [UInt32: Transfer] = [:]
        var toPhone: [UInt32: Transfer] = [:]
        init(peer: RelayPeer) { self.peer = peer }
    }

    final class Game {
        var session: Session
        var host: RelayPeer?
        var hostIsPreview = false
        var players: [Int: Player] = [:]
        var renewed = Date()
        init(session: Session) { self.session = session }
    }

    /// One of a wish's apps in its room, by the peer id it proved itself as, with its link's seals each way.
    final class Member {
        let peer: RelayPeer
        let kind: String
        let name: String
        let device: String
        /// What it speaks, as it said in its join: 1 for an app from before values, which said nothing of it.
        let wire: Int
        let since = Date()
        let rate = Rate()
        var sealer: WishChannel.Sealer
        var opener: WishChannel.Sealer
        /// Where the app listens for the wish's other apps, as it said: what they keep for when Lamp is closed.
        var at: [String] = []
        /// How its link stands, as it last said: its state, and the apps it reaches straight. For Lamp, not the others.
        var link: [String: Any] = [:]
        /// Files on their way from it, by the peer each is for and its id (`sendingKey`).
        var sending: [String: Transfer] = [:]
        /// How often it may send a game's controls to each player, apart (an app, and which of its controllers): a TV app
        /// speaks to each of its players every frame. A few dozen at most are kept, so made-up ids hold nothing for long.
        var padRates: [String: Rate] = [:]
        init(peer: RelayPeer, kind: String, name: String, device: String, wire: Int, sealer: WishChannel.Sealer, opener: WishChannel.Sealer) {
            self.peer = peer
            self.kind = kind
            self.name = name
            self.device = device
            self.wire = wire
            self.sealer = sealer
            self.opener = opener
        }
        var described: [String: Any] { ["kind": kind, "name": name, "device": device, "wire": wire, "since": Int(since.timeIntervalSince1970 * 1000), "at": at] }
        /// What a message `to` reaches: the copy it names, or every copy of the app it names.
        func isFor(_ to: String, id: String) -> Bool { id == to || (!to.contains(".") && WishChannel.app(of: id) == to) }
        /// Everything to a member goes sealed, in the order it's said, on the relay's queue.
        func send(_ text: String) { peer.send(sealed: sealer.seal(Data(text.utf8))) }
    }

    /// A wish's room: its key, which apps it may have (from Lamp, by peer id: what each is called), and which are in it now.
    final class Room {
        let key: SymmetricKey
        let keyData: Data
        let tag: Data
        var apps: [String: (kind: String, name: String)]
        var waiting: Set<String> = []
        var members: [String: Member] = [:]
        /// Lamp keeping the wish's shared collections (`WishKeeper`), when Lamp gave the room a folder for them.
        var keeper: WishKeeper?
        init(key: Data, apps: [String: (kind: String, name: String)]) {
            self.keyData = key
            self.key = SymmetricKey(data: key)
            self.tag = WishChannel.tag(for: self.key)
            self.apps = apps
        }
    }

    public let queue = DispatchQueue(label: "dev.lamp.relay")
    private let key: SymmetricKey
    private var listener: NWListener?
    /// The listener stopped after it was ready (the network went away under it): whoever runs the relay starts it again.
    public var onStopped: @Sendable () -> Void = {}
    private var games: [String: Game] = [:]
    private var rooms: [String: Room] = [:]
    /// Each room by its tag, which is all a hello says of which wish it's for.
    private var tags: [Data: String] = [:]
    /// Sockets past their hello and not yet in a room: proving they hold the wish's key.
    private var proving: [ObjectIdentifier: (peer: RelayPeer, from: String)] = [:]
    /// Who is in a room, each time that changes: the room's key and its members (`peer`, `kind`, `name`, `device`, `since`).
    public var onRoomChanged: @Sendable (_ room: String, _ members: [[String: Any]]) -> Void = { _, _ in }
    /// What a copy said to Lamp itself (`send` to the relay's name): what it has of a page's change. For Lamp alone.
    public var onHeard: @Sendable (_ room: String, _ copy: String, _ data: Any) -> Void = { _, _, _ in }
    /// Sockets not yet past their hello: held here, since nothing else holds them until they're a player or a host.
    private var greeting: [ObjectIdentifier: (peer: RelayPeer, from: String)] = [:]
    /// How many sockets may wait to say hello at once, in all and from one address (an IPv6 one by its network, since a
    /// device can take many there): a phone or a TV opens one at a time.
    static let greetingLimit = (all: 64, each: 8)
    /// Text waiting to go to the host past which phones' messages to it are dropped, well before the host is let go
    /// for falling behind (`RelayPeer.textLimit`). Changed only by tests, which make a host count as behind.
    nonisolated(unsafe) static var hostBehind = 128
    private var ticker: DispatchSourceTimer?

    /// The largest message a socket takes: a file's piece, a game's or a wish's sealed one with its header and seal. A
    /// browser and an Android app send each as one frame, never split, so the whole piece must fit in one.
    public static let messageLimit = ControllerWire.chunk + 1024

    public init(key: SymmetricKey) {
        self.key = key
    }

    // MARK: Listening

    /// Starts listening on every address, at `port` when it's free (the one it had before, so phones' pages find it
    /// where they last did), else wherever the system gives. `ready` hears the port once, nil when it couldn't.
    public func start(port: UInt16 = 0, ready: @escaping @Sendable (UInt16?) -> Void) {
        queue.async { self.listen(port, ready: ready) }
    }

    private func listen(_ port: UInt16, ready: @escaping @Sendable (UInt16?) -> Void) {
        let socket = NWProtocolWebSocket.Options()
        socket.autoReplyPing = true
        socket.maximumMessageSize = Self.messageLimit
        socket.setClientRequestHandler(queue) { [weak self] _, headers in
            let admitted = self?.admits(origin: headers.first { $0.name.lowercased() == "origin" }?.value) ?? false
            return NWProtocolWebSocket.Response(status: admitted ? .accept : .reject, subprotocol: nil)
        }
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(socket, at: 0)
        guard let listener = try? NWListener(using: parameters, on: port == 0 ? .any : (NWEndpoint.Port(rawValue: port) ?? .any)) else {
            return port == 0 ? ready(nil) : listen(0, ready: ready)
        }
        var told = false
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self else { return }
            switch state {
            case .ready:
                guard !told else { return }
                told = true
                ready(listener?.port?.rawValue)
            case .failed:
                listener?.cancel()
                if self.listener === listener { self.listener = nil }
                guard !told else { return self.onStopped() }
                told = true
                // The port it had before is someone else's now: anywhere will do.
                if port != 0 { self.listen(0, ready: ready) } else { ready(nil) }
            default:
                break
            }
        }
        self.listener = listener
        listener.start(queue: queue)
    }

    /// A browser always says which page opened a socket: of web pages, only an app's own phone page, at the port it's
    /// served at by one of this Mac's names, is let in. A TV app's page isn't a web page: in the preview it's at the
    /// preview's own address, on a TV a file of its package ("file://", or "null"), a game's on the Mac at the address
    /// Lamp's app around it serves it at, and a wish's own app sends no origin at all. Each of those, like any client that isn't a browser, could say whatever origin it liked, so the
    /// credential in its hello is what lets it in, as it is for everyone. Which app's page asked isn't known here (the
    /// Network framework doesn't say which socket a handshake is for); a page of one app can't hold another's
    /// credentials, which are what decide the app.
    private func admits(origin: String?) -> Bool {
        guard let origin else { return true }
        if ["null", "file://", "lamp-tv://app", "lamp-game://app"].contains(origin.lowercased()) { return true }
        guard let url = URL(string: origin), url.scheme == "http", let host = url.host?.lowercased(), let port = url.port else { return false }
        return games.values.contains { $0.session.pagePort.map(Int.init) == port && $0.session.hosts.contains(host) }
    }

    /// The process is ending: what each room's keeper hasn't written yet is written now, before this returns, so a
    /// change a copy made in the last moment before Lamp quit isn't lost. Never on the relay's own queue.
    public func finish() {
        queue.sync { for room in rooms.values { room.keeper?.close() } }
    }

    public func stop() {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
            for app in Array(self.games.keys) { self.endGame(app) }
            for room in Array(self.rooms.keys) { self.endRoom(room) }
            for waiting in self.greeting.values { waiting.peer.close(code: 1001) }
            self.greeting = [:]
            for waiting in self.proving.values { waiting.peer.close(code: 1001) }
            self.proving = [:]
            self.ticker?.cancel()
            self.ticker = nil
        }
    }

    // MARK: Sessions, from Lamp

    /// Opens an app's session, or brings it up to date (its page moved). A new generation ends the old game first.
    public func configure(app: String, _ session: Session) {
        queue.async {
            if let game = self.games[app], game.session.generation != session.generation { self.endGame(app) }
            if let game = self.games[app] {
                let moved = game.session.page != session.page
                game.session = session
                if moved, game.host != nil { self.sendLink(game, app: app) }
            } else {
                self.games[app] = Game(session: session)
                self.startTicking()
            }
        }
    }

    /// The app's session is over: its phones and host are let go.
    public func end(app: String) {
        queue.async { self.endGame(app) }
    }

    private func endGame(_ app: String) {
        guard let game = games.removeValue(forKey: app) else { return }
        for player in game.players.values { player.peer?.close(code: 4005) }
        game.host?.close(code: 4005)
    }

    /// Opens a wish's room, or brings it up to date (an app added or taken away). `key`: the wish's key, which every app
    /// of the wish holds and proves it does to get in; `apps`: each app the wish may have, by its peer id, with its kind
    /// and name; a peer whose id isn't among them is turned away. `waiting`: those of them Lamp hasn't made yet, so the
    /// others can say so. `keep`: the folder Lamp keeps the wish's shared collections in (`WishKeeper`), none for a
    /// room that keeps nothing. A new key ends the old room first, letting its members go.
    public func configureRoom(_ room: String, key: Data, apps: [String: (kind: String, name: String)], waiting: Set<String> = [], keep: URL? = nil) {
        queue.async {
            if let known = self.rooms[room], known.keyData != key { self.closeRoom(room) }
            if let known = self.rooms[room] {
                known.keeper?.appCount = apps.count
                let changed = Set(known.apps.map { "\($0.key)\t\($0.value.kind)\t\($0.value.name)" })
                    != Set(apps.map { "\($0.key)\t\($0.value.kind)\t\($0.value.name)" }) || known.waiting != waiting
                known.apps = apps
                known.waiting = waiting
                for (id, member) in known.members where apps[WishChannel.app(of: id)] == nil { member.peer.close(code: 4005); known.members[id] = nil }
                // An app added to the wish or taken from it, while the others are in the room: they hear the list again,
                // so the one not open yet is known to them, and the one gone isn't.
                if changed {
                    let list = Self.json(["t": "apps", "apps": Self.roster(known)])
                    for member in known.members.values { member.send(list) }
                }
            } else {
                let made = Room(key: key, apps: apps)
                made.waiting = waiting
                if let keep { made.keeper = self.keeper(for: made, in: keep) }
                self.rooms[room] = made
                self.tags[made.tag] = room
                self.startTicking()
            }
        }
    }

    /// Lamp's own word to some copies of a wish's apps (a page's change put into each open copy, `Store.pageToCopies`):
    /// passed as a message from the relay's own name, which no app of a wish has (`prove`), so a page can tell it's
    /// Lamp's. `done` is told the copies it went to.
    public func say(in room: String, to copies: [String], data: Any, done: @escaping ([String]) -> Void) {
        queue.async {
            guard let known = self.rooms[room] else { return done([]) }
            let out = Self.json(["t": "message", "from": WishChannel.relayName, "data": data, "at": Self.now])
            var reached: [String] = []
            for id in copies.sorted() {
                guard let member = known.members[id] else { continue }
                member.send(out)
                reached.append(id)
            }
            done(reached)
        }
    }

    /// The wish is gone, or its room isn't wanted any more: its members are let go. `forget`: the wish is gone, and what
    /// Lamp kept of its shared collections goes with it.
    public func endRoom(_ room: String, forget: Bool = false) {
        queue.async {
            if forget { self.rooms[room]?.keeper?.forget() }
            self.closeRoom(room)
        }
    }

    /// Lamp as a keeper of the room's shared collections, speaking to its members as the relay's own name.
    private func keeper(for room: Room, in folder: URL) -> WishKeeper {
        let keeper = WishKeeper(folder: folder, key: room.key, queue: queue)
        keeper.appCount = room.apps.count
        keeper.send = { [weak room] copy, message in
            // A copy that has stopped reading misses what's said meanwhile, as from another copy: the next sums make it up.
            guard let member = room?.members[copy], member.wire >= WishKeeper.wire, member.peer.pendingText <= Self.hostBehind else { return }
            var out = message
            out["from"] = WishChannel.relayName
            member.send(Self.json(out))
        }
        keeper.sendPiece = { [weak room] copy, piece in
            guard let member = room?.members[copy], member.wire >= WishKeeper.wire else { return false }
            return member.peer.send(piece: piece, seal: { [weak member] plain in member?.sealer.seal(plain) ?? Data() })
        }
        keeper.present = { [weak room] in room?.members.mapValues(\.wire) ?? [:] }
        return keeper
    }

    private func closeRoom(_ room: String) {
        guard let known = rooms.removeValue(forKey: room) else { return }
        known.keeper?.close()
        if tags[known.tag] == room { tags[known.tag] = nil }
        for member in known.members.values { member.peer.close(code: 4005) }
        if !known.members.isEmpty { onRoomChanged(room, []) }
    }

    // MARK: Sockets

    private func accept(_ connection: NWConnection) {
        var from = "?"
        if case .hostPort(let host, _) = connection.endpoint {
            switch host {
            case .ipv6(let address) where address.asIPv4 == nil: from = address.rawValue.prefix(8).map { String(format: "%02x", $0) }.joined()
            default: from = "\(host)"
            }
        }
        // Unproven sockets are held to these from their hello through a wish's handshake, which a tag seen on the
        // network is enough to start.
        guard greeting.count + proving.count < Self.greetingLimit.all,
              greeting.values.filter({ $0.from == from }).count + proving.values.filter({ $0.from == from }).count < Self.greetingLimit.each else {
            return connection.cancel()
        }
        let peer = RelayPeer(connection: connection)
        let id = ObjectIdentifier(peer)
        var greeted = false
        greeting[id] = (peer, from)
        peer.onClose = { [weak self] in self?.greeting[id] = nil }
        peer.onBinary = { [weak peer] _ in peer?.close(code: 4003) }
        peer.onText = { [weak self, weak peer] text in
            guard let self, let peer, !greeted else { return }
            greeted = true
            self.greeting[id] = nil
            self.hello(peer, text: text, from: from)
        }
        peer.start(on: queue)
        startTicking()
        queue.asyncAfter(deadline: .now() + 5) { [weak self, weak peer] in
            guard !greeted else { return }
            peer?.close(code: 4001)
            self?.greeting[id] = nil
        }
    }

    private func hello(_ peer: RelayPeer, text: String, from: String) {
        guard let hello = Self.parse(text), hello["t"] as? String == "hello" else { return peer.close(code: 4003) }
        // A wish's app names its wish by its tag alone; a TV app's game is named by its app, with a credential for it.
        if hello["tag"] != nil { return prove(peer, hello: hello, from: from) }
        guard let app = hello["app"] as? String, let game = games[app],
              let claim = ControllerToken.check(hello["credential"] as? String, kinds: [.host, .join, .controller], app: app,
                                                generation: game.session.generation, key: key)
        else { return peer.close(code: 4003) }
        if claim.kind == .host { return joinAsHost(peer, game: game, app: app, preview: claim.preview) }
        joinAsPlayer(peer, game: game, app: app, resuming: claim.kind == .controller ? claim.player : nil)
    }

    // MARK: A wish's room

    /// A wish's app proving it holds the wish's key (`WishChannel`): its hello names the wish by tag and itself by peer
    /// id, with a nonce; the relay answers with its own nonce and its proof, and lets it into the room once its proof
    /// checks and its first sealed message says what device it is. Anything else, or nothing for a few seconds, and the
    /// socket goes, with one code for all of it so nobody learns which part was wrong.
    private func prove(_ peer: RelayPeer, hello: [String: Any], from: String) {
        guard let tag = (hello["tag"] as? String).flatMap({ Data(base64Encoded: $0) }), tag.count == WishChannel.tagSize,
              let roomKey = tags[tag], let room = rooms[roomKey],
              let id = hello["peer"] as? String, WishChannel.isName(id), room.apps[WishChannel.app(of: id)] != nil,
              // The relay's own name is Lamp's (`say`): no app takes it.
              WishChannel.app(of: id) != WishChannel.relayName,
              let clientNonce = (hello["nonce"] as? String).flatMap({ Data(base64Encoded: $0) }), clientNonce.count == WishChannel.nonceSize
        else { return peer.close(code: 4003) }
        let serverNonce = WishChannel.random(WishChannel.nonceSize)
        let transcript = WishChannel.transcript(tag: tag, client: id, server: WishChannel.relayName, clientNonce: clientNonce, serverNonce: serverNonce)
        let handle = ObjectIdentifier(peer)
        proving[handle] = (peer, from)
        peer.onClose = { [weak self] in self?.proving[handle] = nil }
        peer.send(Self.json(["t": "challenge", "peer": WishChannel.relayName, "nonce": serverNonce.base64EncodedString(),
                             "proof": WishChannel.serverProof(key: room.key, transcript: transcript).base64EncodedString()]))
        var proven = false
        peer.onText = { [weak self, weak peer, weak room] text in
            guard let self, let peer, let room else { return }
            guard !proven, let said = Self.parse(text), said["t"] as? String == "proof",
                  let proof = (said["proof"] as? String).flatMap({ Data(base64Encoded: $0) }),
                  WishChannel.same(proof, WishChannel.clientProof(key: room.key, transcript: transcript)) else { return peer.close(code: 4003) }
            proven = true
            let keys = WishChannel.keys(key: room.key, transcript: transcript)
            var opener = WishChannel.Sealer(key: keys.client)
            // From here on nothing goes in clear: a text message is someone else's, and lets the link go.
            peer.onText = { [weak peer] _ in peer?.close(code: 4003) }
            peer.onBinary = { [weak self, weak peer, weak room] sealed in
                guard let self, let peer, let room else { return }
                guard let plain = opener.open(sealed), let join = Self.parse(String(decoding: plain, as: UTF8.self)), join["t"] as? String == "join",
                      self.rooms[roomKey] === room, let named = room.apps[WishChannel.app(of: id)] else { return peer.close(code: 4003) }
                self.proving[handle] = nil
                self.joinRoom(peer, room: room, key: roomKey, id: id, kind: named.kind, name: named.name, device: Self.short(join["device"], 40),
                              wire: (join["wire"] as? Int).map { min(max($0, 1), 999) } ?? 1, sealer: WishChannel.Sealer(key: keys.server), opener: opener)
            }
        }
        peer.onBinary = { [weak peer] _ in peer?.close(code: 4003) }
        queue.asyncAfter(deadline: .now() + 5) { [weak self, weak peer] in
            guard let self, let peer, self.proving[handle]?.peer === peer else { return }
            self.proving[handle] = nil
            peer.close(code: 4001)
        }
    }

    private func joinRoom(_ peer: RelayPeer, room: Room, key: String, id: String, kind: String, name: String, device: String, wire: Int,
                          sealer: WishChannel.Sealer, opener: WishChannel.Sealer) {
        // The same copy of the app back on a new socket (reopened, or its old link not yet noticed gone): the new one is it.
        // A copy is an app on one device ("screen.k3j9x0ab"), so the same app open on another device is a member of its own.
        // The others hear that it left before they hear it join, so they see it arrive again and can catch it up on what
        // it missed.
        if let old = room.members[id] {
            old.peer.onClose = {}
            old.peer.close(code: 4000)
            room.members[id] = nil
            Self.dropFiles(to: id, in: room)
            room.keeper?.left(id)
            let left = Self.json(["t": "left", "peer": id])
            for (_, each) in room.members { each.send(left) }
        }
        let member = Member(peer: peer, kind: kind, name: name, device: device, wire: wire, sealer: sealer, opener: opener)
        let others = room.members.sorted { $0.key < $1.key }.map { Self.described($0.key, $0.value) }
        room.members[id] = member
        var welcome: [String: Any] = ["t": "welcome", "role": "peer", "peer": id, "peers": others, "apps": Self.roster(room), "now": Self.now]
        // Lamp keeps the wish's shared collections: a copy that knows it shares them with Lamp too.
        if room.keeper != nil { welcome["keeps"] = true }
        member.send(Self.json(welcome))
        let joined = Self.json(["t": "joined", "peer": Self.described(id, member)])
        for (other, each) in room.members where other != id { each.send(joined) }
        // Beats are the one thing said in clear, both ways: they carry nothing, and an app that can't hold a socket has Lamp
        // beat for it (`WishProxies`). Any other text is someone else's, and lets the link go.
        peer.onText = { [weak peer] text in if Self.parse(text)?["t"] as? String != "beat" { peer?.close(code: 4003) } }
        peer.onBinary = { [weak self, weak room, weak member] sealed in
            guard let self, let room, let member else { return }
            // A message that doesn't open as the next one from this app was changed, replayed or made up on the way.
            guard let plain = member.opener.open(sealed) else { return member.peer.close(code: 4003) }
            if plain.first == 1 { return self.pieceFromMember(room, id: id, member: member, data: plain) }
            guard plain.count <= WishChannel.sealedLimit else { return member.peer.close(code: 1009) }
            self.fromMember(room, key: key, id: id, member: member, text: String(decoding: plain, as: UTF8.self))
        }
        peer.onClose = { [weak self, weak room, weak member] in
            guard let self, let room, let member, room.members[id] === member else { return }
            room.members[id] = nil
            Self.dropFiles(to: id, in: room)
            room.keeper?.left(id)
            let left = Self.json(["t": "left", "peer": id])
            for each in room.members.values { each.send(left) }
            self.onRoomChanged(key, self.membersDescribed(room))
        }
        onRoomChanged(key, membersDescribed(room))
        room.keeper?.joined(id, wire: wire)
    }

    private func fromMember(_ room: Room, key: String, id: String, member: Member, text: String) {
        guard let message = Self.parse(text) else { return }
        let kind = message["t"] as? String ?? ""
        // How the app's link stands, for whoever builds the wish to see; said only when it changes.
        if kind == "status", member.rate.allowed(member.peer) {
            let direct = (message["direct"] as? [String] ?? []).filter { WishChannel.isName($0) && room.apps[WishChannel.app(of: $0)] != nil }.prefix(8)
            member.link = ["state": Self.short(message["state"], 32), "direct": Array(direct)]
            return onRoomChanged(key, membersDescribed(room))
        }
        // Where the app listens: a few addresses, each host:port, passed to the others to keep.
        if kind == "at", member.rate.allowed(member.peer), let given = message["addresses"] as? [String] {
            member.at = Array(given.filter { $0.utf8.count <= 64 && !$0.contains(where: { $0.isWhitespace }) }.prefix(8))
            let said = Self.json(["t": "at", "peer": id, "addresses": member.at])
            for (other, each) in room.members where other != id { each.send(said) }
            return
        }
        // The values the wish's apps share, for one copy (or each copy of one app): passed on as they are, since each copy
        // keeps and merges its own.
        if kind == "values", member.rate.allowed(member.peer), let values = message["values"] as? [String: Any],
           let to = message["to"] as? String {
            // With what the sender's values add up to, or its request for all of the other's, so a setting lost on the
            // way is made up.
            var out: [String: Any] = ["t": "values", "from": id, "values": values]
            if let sum = message["sum"] as? String, sum.utf8.count <= 64 { out["sum"] = sum }
            if message["ask"] as? Bool == true { out["ask"] = true }
            let said = Self.json(out)
            for (other, each) in room.members where other != id && each.isFor(to, id: other) && each.peer.pendingText <= Self.hostBehind { each.send(said) }
            return
        }
        // The app's shared collections (`LampStore.shared`), for one copy (or each copy of one app) that speaks 5: passed on
        // as they are, since each copy keeps and merges its own.
        if kind == "store", member.rate.allowed(member.peer), let to = message["to"] as? String {
            // For Lamp, which keeps the wish's collections; and what copies say to each other is kept as well.
            if to == WishChannel.relayName { return room.keeper?.heard(message, from: id) ?? () }
            room.keeper?.overheard(message, from: id)
            var out = message
            out["to"] = nil
            out["from"] = id
            let said = Self.json(out)
            for (other, each) in room.members where other != id && each.wire >= 5 && each.isFor(to, id: other) && each.peer.pendingText <= Self.hostBehind { each.send(said) }
            return
        }
        if kind == "pad" || kind.hasPrefix("file") { return fileOrPad(room, id: id, member: member, kind: kind, message: message) }
        guard kind == "send", member.rate.allowed(member.peer), let data = message["data"] else { return }
        let to = message["to"] as? String
        if to == WishChannel.relayName { return onHeard(key, id, data) }
        let out = Self.json(["t": "message", "from": id, "data": data, "at": Self.now])
        if let to {
            // To one copy, or to every copy of one app. Told when none is there, or the one it's for has stopped reading,
            // so the sender's library can say so.
            let targets = room.members.filter { $0.key != id && $0.value.isFor(to, id: $0.key) }
            let reading = targets.values.filter { $0.peer.pendingText <= Self.hostBehind }
            guard !reading.isEmpty else {
                return member.send(Self.json(["t": "undelivered", "to": to, "reason": targets.isEmpty ? "not in the room" : "busy"]))
            }
            for target in reading { target.send(out) }
        } else {
            for (other, each) in room.members where other != id && each.peer.pendingText <= Self.hostBehind { each.send(out) }
        }
    }

    /// A file's messages and a game's controls, each for one app (`to`) and passed on as from the sender (`from`), only to an
    /// app that speaks 3 or more. A file is held to the size it was announced at and to a window ahead of what its receiver
    /// has acknowledged, as a phone's is; its acknowledgements aren't counted against the rate, since they're what keeps it
    /// moving.
    private func fileOrPad(_ room: Room, id: String, member: Member, kind: String, message: [String: Any]) {
        guard let to = message["to"] as? String, to != id else { return }
        // A shared file's bytes to or from Lamp, which keeps them (`WishKeeper`).
        if to == WishChannel.relayName {
            guard let keeper = room.keeper, kind != "pad" else { return }
            if kind == "file" {
                guard member.rate.allowed(member.peer) else { return }
                keeper.fileStarts(message, from: id)
            } else {
                keeper.fileEnded(message, from: id)
            }
            return
        }
        let target = room.members[to].flatMap { $0.wire >= 3 ? $0 : nil }
        switch kind {
        case "pad":
            // A button let go is never dropped for a TV that's behind: one it thinks is still held stays held.
            // By the player it's for or from: an app, and which of its controllers (`pad`), since each is a player of its own.
            let player = to + "\t" + Self.short((message["m"] as? [String: Any])?["pad"], 16)
            if member.padRates[player] == nil, member.padRates.count >= 64 { member.padRates = [:] }
            let rate = member.padRates[player] ?? Rate()
            member.padRates[player] = rate
            guard room.apps[WishChannel.app(of: to)] != nil, rate.allowed(member.peer), let m = message["m"] as? [String: Any], let target,
                  target.peer.pendingText <= Self.hostBehind || (m["t"] as? String == "button" && m["down"] as? Bool != true) else { return }
            target.send(Self.json(["t": "pad", "from": id, "m": m]))
        case "file":
            guard member.rate.allowed(member.peer), let fileID = ControllerWire.isID(message["id"]) else { return }
            let refuse = { (reason: String) in member.send(Self.json(["t": "file-refuse", "from": to, "id": fileID, "reason": reason])) }
            guard let size = message["size"] as? Int, size >= 0, size <= ControllerWire.file else { return refuse("The file is too big to send.") }
            guard let target else { return refuse(room.members[to] == nil ? "That app isn't open." : "That app is out of date.") }
            guard target.peer.pendingText <= Self.hostBehind else { return refuse("That app is busy; try again.") }
            let key = Self.sendingKey(to, fileID)
            guard member.sending[key] == nil, member.sending.keys.filter({ $0.hasPrefix(to + "\t") }).count < ControllerWire.transfers else {
                return refuse("Another file is still on its way.")
            }
            member.sending[key] = Transfer(size: size)
            target.send(Self.json(["t": "file", "from": id, "id": fileID, "name": Self.short(message["name"], 200),
                                   "type": Self.short(message["type"], 100), "size": size, "ch": Self.short(message["ch"], 16)]))
        case "file-cancel":
            guard let fileID = ControllerWire.isID(message["id"]), member.sending.removeValue(forKey: Self.sendingKey(to, fileID)) != nil else { return }
            target?.send(Self.json(["t": "file-cancel", "from": id, "id": fileID]))
        case "file-ack":
            // From the file's receiver, for its sender's transfer.
            guard let fileID = ControllerWire.isID(message["id"]), let sender = room.members[to], let got = message["got"] as? Int,
                  let transfer = sender.sending[Self.sendingKey(id, fileID)], transfer.acknowledge(got) else { return }
            if got == transfer.size { sender.sending[Self.sendingKey(id, fileID)] = nil }
            sender.send(Self.json(["t": "file-ack", "from": id, "id": fileID, "got": got]))
        case "file-refuse":
            guard let fileID = ControllerWire.isID(message["id"]), let sender = room.members[to],
                  sender.sending.removeValue(forKey: Self.sendingKey(id, fileID)) != nil else { return }
            sender.send(Self.json(["t": "file-refuse", "from": id, "id": fileID, "reason": Self.short(message["reason"], 200)]))
        default:
            break
        }
    }

    /// A piece of a file from a member, for the peer its header names: passed on sealed for that peer, with the sender's
    /// name in its place. A piece past the file's size, or past the window the receiver has acknowledged, is a sender
    /// that doesn't keep to what it said: the file goes no further, and both hear so.
    private func pieceFromMember(_ room: Room, id: String, member: Member, data: Data) {
        guard let (to, fileID, offset) = WishChannel.pieceHeader(data) else { return }
        if to == WishChannel.relayName {
            let bytes = data.dropFirst(offset)
            guard !bytes.isEmpty, bytes.count <= ControllerWire.chunk else { return }
            return room.keeper?.piece(Data(bytes), id: fileID, from: id) ?? ()
        }
        guard let transfer = member.sending[Self.sendingKey(to, fileID)] else { return }
        let bytes = data.count - offset
        let kept = room.members[to] != nil && bytes > 0 && bytes <= ControllerWire.chunk && transfer.passed + bytes <= transfer.size
            && transfer.passed + bytes - transfer.acknowledged <= ControllerWire.window + ControllerWire.chunk
        guard kept, let target = room.members[to],
              target.peer.send(piece: WishChannel.piece(peer: id, id: fileID, bytes: data.dropFirst(offset)),
                               seal: { [weak target] plain in target?.sealer.seal(plain) ?? Data() }) else {
            member.sending[Self.sendingKey(to, fileID)] = nil
            room.members[to]?.send(Self.json(["t": "file-cancel", "from": id, "id": fileID]))
            member.send(Self.json(["t": "file-refuse", "from": to, "id": fileID,
                                   "reason": kept ? "That app is busy; try again." : "The file didn't keep to its size."]))
            return
        }
        transfer.passed += bytes
        transfer.unacknowledged += 1
    }

    private static func sendingKey(_ to: String, _ id: UInt32) -> String { "\(to)\t\(id)" }

    /// A member gone: the files on their way to it go with it (its own went with it), and their senders hear it left.
    private static func dropFiles(to id: String, in room: Room) {
        for member in room.members.values { member.sending = member.sending.filter { !$0.key.hasPrefix(id + "\t") } }
    }

    /// Every app the room's wish has, as a member is told it: in its welcome, and again when the list changes.
    private static func roster(_ room: Room) -> [[String: Any]] {
        room.apps.sorted { $0.key < $1.key }.map { id, app in
            var described: [String: Any] = ["peer": id, "kind": app.kind, "name": app.name]
            if room.waiting.contains(id) { described["waiting"] = true }
            return described
        }
    }

    /// A member as the others are told of it: its peer name (which copy it is), and the app it's a copy of.
    private static func described(_ id: String, _ member: Member) -> [String: Any] {
        var described = member.described
        described["peer"] = id
        described["app"] = WishChannel.app(of: id)
        return described
    }

    private func membersDescribed(_ room: Room) -> [[String: Any]] {
        room.members.sorted { $0.key < $1.key }.map { id, member in
            var described = Self.described(id, member)
            if !member.link.isEmpty { described["link"] = member.link }
            return described
        }
    }

    private func joinAsHost(_ peer: RelayPeer, game: Game, app: String, preview: Bool) {
        if let old = game.host {
            // The preview is the app's host on this Mac: a TV running the same app meanwhile waits for it to close.
            if game.hostIsPreview && !preview { return peer.close(code: 4009) }
            old.onClose = {}
            old.close(code: 4000)
            dropTransfers(game)
            // The files on their way to or from the old host end with it, and each phone hears so, as when a host just
            // leaves, before it hears the new one is there.
            for player in game.players.values { player.peer?.send(#"{"t":"state","host":false}"#) }
        }
        game.host = peer
        game.hostIsPreview = preview
        peer.onText = { [weak self, weak game] text in
            guard let self, let game, let message = Self.parse(text) else { return }
            self.fromHost(game, app: app, message: message)
        }
        peer.onBinary = { [weak self, weak game] data in
            guard let self, let game else { return }
            self.pieceFromHost(game, data: data)
        }
        peer.onClose = { [weak self, weak game, weak peer] in
            guard let self, let game, game.host === peer else { return }
            game.host = nil
            game.hostIsPreview = false
            self.dropTransfers(game)
            for player in game.players.values { player.peer?.send(#"{"t":"state","host":false}"#) }
        }
        let players = game.players.filter { $0.value.peer != nil }.keys.sorted()
        peer.send(Self.json(["t": "welcome", "role": "host", "players": players, "now": Self.now]))
        for player in game.players.values { player.peer?.send(#"{"t":"state","host":true}"#) }
    }

    private func joinAsPlayer(_ peer: RelayPeer, game: Game, app: String, resuming: Int?) {
        let now = Date()
        var number = resuming
        if let resuming, let old = game.players[resuming]?.peer {
            old.onClose = {}
            old.close(code: 4000)   // the same phone, back on a new connection
            if let host = game.host { host.send(Self.json(["t": "left", "player": resuming])) }
        }
        if number == nil {
            number = (1...ControllerWire.players).first { n in
                guard let player = game.players[n] else { return true }
                return player.peer == nil && player.heldUntil < now
            }
        }
        guard let number else {
            peer.send(#"{"t":"full"}"#)
            return peer.close(code: 4004)
        }
        let player = Player(peer: peer)
        game.players[number] = player
        peer.send(Self.json(["t": "welcome", "role": "controller", "place": number, "host": game.host != nil,
                             "credential": ControllerToken.issue(kind: .controller, app: app, generation: game.session.generation,
                                                                 player: number, key: key)]))
        game.host?.send(Self.json(["t": "joined", "player": number]))
        peer.onText = { [weak self, weak game, weak player] text in
            guard let self, let game, let player else { return }
            self.fromPlayer(game, number: number, player: player, text: text)
        }
        peer.onBinary = { [weak self, weak game, weak player] data in
            guard let self, let game, let player else { return }
            self.pieceFromPlayer(game, number: number, player: player, data: data)
        }
        peer.onClose = { [weak game, weak player, weak peer] in
            guard let game, let player, game.players[number] === player, player.peer === peer else { return }
            player.peer = nil
            player.heldUntil = Date().addingTimeInterval(ControllerToken.Kind.controller.lifetime)
            player.toHost = [:]
            player.toPhone = [:]
            game.host?.send(Self.json(["t": "left", "player": number]))
        }
    }

    // MARK: From a phone

    private func fromPlayer(_ game: Game, number: Int, player: Player, text: String) {
        guard let message = Self.parse(text) else { return }
        let kind = message["t"] as? String ?? ""
        // A file's acknowledgements come as fast as its pieces, and are what keeps it moving: they aren't counted.
        guard ["file-ack", "file-cancel", "file-refuse"].contains(kind) || allowed(player) else { return }
        guard let host = game.host else {
            if kind == "file", let id = ControllerWire.isID(message["id"]) {
                player.peer?.send(Self.json(["t": "file-refuse", "id": id, "reason": "The TV app isn't there."]))
            }
            return
        }
        // A TV that's behind isn't let go for what phones send it: what they send meanwhile is dropped instead, all but
        // what keeps a file moving, and buttons, whose letting go the TV must never miss (a button it thinks is still
        // held stays held). They're small, and the rate a phone may send at bounds them.
        if host.pendingText > Self.hostBehind, !["file-ack", "file-cancel", "file-refuse", "button"].contains(kind) {
            if kind == "file", let id = ControllerWire.isID(message["id"]) { refuse(player, id: id, "The TV app is busy; try again.") }
            return
        }
        let at = Self.now
        let seq = message["seq"] as? Int ?? 0
        let name = (message["name"] as? String).flatMap { $0.range(of: "^[A-Za-z0-9_-]{1,32}$", options: .regularExpression) != nil ? $0 : nil }
        switch kind {
        case "button":
            guard let name else { return }
            host.send(Self.json(["t": "button", "player": number, "name": name, "down": message["down"] as? Bool == true, "seq": seq, "at": at]))
        case "axis":
            guard let name else { return }
            // Movement is only worth its latest value: when the TV is behind, it's dropped rather than queued.
            if host.pendingText > ControllerWire.backlog { return }
            host.send(Self.json(["t": "axis", "player": number, "name": name, "x": Self.clamp(message["x"]), "y": Self.clamp(message["y"]), "seq": seq, "at": at]))
        case "message":
            guard let data = message["data"] else { return }
            host.send(Self.json(["t": "message", "player": number, "data": data, "at": at]))
        case "too-big":
            // A message the phone's own library refused as over the limit: said in the TV app's log, where the builder
            // looks, since the phone's console is out of sight.
            guard let bytes = message["bytes"] as? Int else { return }
            host.send(Self.json(["t": "too-big", "player": number, "bytes": bytes]))
        case "file":
            guard let id = ControllerWire.isID(message["id"]) else { return }
            guard let size = message["size"] as? Int, size >= 0, size <= ControllerWire.file else {
                return refuse(player, id: id, "The file is too big to send.")
            }
            guard player.toHost[id] == nil, player.toHost.count < ControllerWire.transfers else {
                return refuse(player, id: id, "Another file is still on its way.")
            }
            player.toHost[id] = Transfer(size: size)
            host.send(Self.json(["t": "file", "player": number, "id": id, "name": Self.short(message["name"], 200),
                                 "type": Self.short(message["type"], 100), "size": size, "at": at]))
        case "file-cancel":
            guard let id = ControllerWire.isID(message["id"]), player.toHost.removeValue(forKey: id) != nil else { return }
            host.send(Self.json(["t": "file-cancel", "player": number, "id": id]))
        case "file-ack":
            guard let id = ControllerWire.isID(message["id"]), let transfer = player.toPhone[id], let got = message["got"] as? Int,
                  transfer.acknowledge(got) else { return }
            if got == transfer.size { player.toPhone[id] = nil }
            host.send(Self.json(["t": "file-ack", "player": number, "id": id, "got": got]))
        case "file-refuse":
            guard let id = ControllerWire.isID(message["id"]), player.toPhone.removeValue(forKey: id) != nil else { return }
            host.send(Self.json(["t": "file-refuse", "player": number, "id": id, "reason": Self.short(message["reason"], 200)]))
        default:
            break
        }
    }

    private func pieceFromPlayer(_ game: Game, number: Int, player: Player, data: Data) {
        guard let (_, id) = ControllerWire.chunkHeader(data), let transfer = player.toHost[id] else { return }
        let bytes = data.count - ControllerWire.header
        // A piece past the file's size, or past the window the host has acknowledged, is a sender that doesn't keep to
        // what it said: the file goes no further.
        guard let host = game.host, bytes > 0, transfer.passed + bytes <= transfer.size,
              transfer.passed + bytes - transfer.acknowledged <= ControllerWire.window + ControllerWire.chunk,
              host.send(piece: ControllerWire.readdressed(data, to: UInt8(number))) else {
            player.toHost[id] = nil
            game.host?.send(Self.json(["t": "file-cancel", "player": number, "id": id]))
            return refuse(player, id: id, "The file didn't keep to its size.")
        }
        transfer.passed += bytes
        transfer.unacknowledged += 1
    }

    // MARK: From the host

    private func fromHost(_ game: Game, app: String, message: [String: Any]) {
        let number = message["player"] as? Int ?? 0
        let player = game.players[number]
        switch message["t"] as? String {
        case "link":
            sendLink(game, app: app)
        case "send":
            guard let data = message["data"] else { return }
            let text = Self.json(["t": "message", "data": data])
            for (place, each) in game.players where number == 0 || number == place { each.peer?.send(text) }
        case "player":
            // The number the TV page knows this phone by, which the phone shows.
            guard let player, let shown = message["number"] as? Int, shown > 0, shown < 1000 else { return }
            player.peer?.send(Self.json(["t": "player", "number": shown]))
        case "file":
            guard let id = ControllerWire.isID(message["id"]) else { return }
            guard let player, let peer = player.peer, let size = message["size"] as? Int, size >= 0, size <= ControllerWire.file,
                  player.toPhone[id] == nil, player.toPhone.count < ControllerWire.transfers else {
                game.host?.send(Self.json(["t": "file-refuse", "player": number, "id": id, "reason": "The phone can't take it now."]))
                return
            }
            player.toPhone[id] = Transfer(size: size)
            peer.send(Self.json(["t": "file", "id": id, "name": Self.short(message["name"], 200), "type": Self.short(message["type"], 100), "size": size]))
        case "file-cancel":
            guard let id = ControllerWire.isID(message["id"]), let player, player.toPhone.removeValue(forKey: id) != nil else { return }
            player.peer?.send(Self.json(["t": "file-cancel", "id": id]))
        case "file-ack":
            guard let id = ControllerWire.isID(message["id"]), let player, let transfer = player.toHost[id], let got = message["got"] as? Int,
                  transfer.acknowledge(got) else { return }
            if got == transfer.size { player.toHost[id] = nil }
            player.peer?.send(Self.json(["t": "file-ack", "id": id, "got": got]))
        case "file-refuse":
            guard let id = ControllerWire.isID(message["id"]), let player, player.toHost.removeValue(forKey: id) != nil else { return }
            player.peer?.send(Self.json(["t": "file-refuse", "id": id, "reason": Self.short(message["reason"], 200)]))
        default:
            break
        }
    }

    private func pieceFromHost(_ game: Game, data: Data) {
        guard let (place, id) = ControllerWire.chunkHeader(data), let player = game.players[Int(place)], let transfer = player.toPhone[id] else { return }
        let bytes = data.count - ControllerWire.header
        guard let peer = player.peer, bytes > 0, transfer.passed + bytes <= transfer.size,
              transfer.passed + bytes - transfer.acknowledged <= ControllerWire.window + ControllerWire.chunk,
              peer.send(piece: ControllerWire.readdressed(data, to: 0)) else {
            return cancelToPhone(game, number: Int(place), player: player, id: id)
        }
        transfer.passed += bytes
        transfer.unacknowledged += 1
    }

    private func cancelToPhone(_ game: Game, number: Int, player: Player, id: UInt32) {
        player.toPhone[id] = nil
        player.peer?.send(Self.json(["t": "file-cancel", "id": id]))
        game.host?.send(Self.json(["t": "file-refuse", "player": number, "id": id, "reason": "The file didn't keep to its size."]))
    }

    private func refuse(_ player: Player, id: UInt32, _ reason: String) {
        player.peer?.send(Self.json(["t": "file-refuse", "id": id, "reason": reason]))
    }

    /// A host that leaves takes every file on its way with it; each phone hears its host has gone, which ends its own.
    private func dropTransfers(_ game: Game) {
        for player in game.players.values {
            player.toHost = [:]
            player.toPhone = [:]
        }
    }

    /// A link for phones: the page's address with a fresh join credential after the #.
    private func sendLink(_ game: Game, app: String) {
        guard let page = game.session.page, let host = game.host else { return }
        let join = ControllerToken.issue(kind: .join, app: app, generation: game.session.generation, key: key)
        host.send(Self.json(["t": "link", "url": page + "#" + join]))
    }

    private func allowed(_ player: Player) -> Bool { player.rate.allowed(player.peer) }

    // MARK: Beats

    // Every few seconds: a beat on every socket (with the relay's time, which the host uses to tell how old movement
    // is), fresh credentials for the phones each minute, and sockets that have gone quiet let go.
    private func startTicking() {
        guard ticker == nil else { return }
        let ticker = DispatchSource.makeTimerSource(queue: queue)
        ticker.schedule(deadline: .now() + ControllerWire.beat, repeating: ControllerWire.beat)
        ticker.setEventHandler { [weak self] in self?.tick() }
        ticker.resume()
        self.ticker = ticker
    }

    private func tick() {
        let now = Date()
        let beat = Self.json(["t": "beat", "now": Self.now])
        for (app, game) in games {
            let renew = now.timeIntervalSince(game.renewed) >= 60
            if renew { game.renewed = now }
            for (number, player) in game.players {
                guard let peer = player.peer else {
                    if player.heldUntil < now { game.players[number] = nil }
                    continue
                }
                if now.timeIntervalSince(peer.heard) > ControllerWire.silence { peer.close(code: 4002); continue }
                peer.send(beat)
                if renew {
                    peer.send(Self.json(["t": "credential", "credential": ControllerToken.issue(kind: .controller, app: app, generation: game.session.generation,
                                                                                               player: number, key: key)]))
                }
            }
            if let host = game.host {
                if now.timeIntervalSince(host.heard) > ControllerWire.silence { host.close(code: 4002) } else { host.send(beat) }
            }
        }
        for room in rooms.values {
            room.keeper?.tick()
            for member in room.members.values {
                if now.timeIntervalSince(member.peer.heard) > ControllerWire.silence { member.peer.close(code: 4002); continue }
                member.peer.send(#"{"t":"beat"}"#)
            }
        }
    }

    // MARK: For tests

    /// The app's session as the relay has it, read on its queue.
    public func hasSession(_ app: String) -> Bool { queue.sync { games[app] != nil } }
    /// Who is in a room now, read on its queue.
    public func members(of room: String) -> [String] { queue.sync { rooms[room]?.members.keys.sorted() ?? [] } }

    private static var now: Int { Int(Date().timeIntervalSince1970 * 1000) }
    private static func clamp(_ value: Any?) -> Double {
        guard let n = (value as? NSNumber)?.doubleValue, n.isFinite else { return 0 }
        return max(-1, min(1, n))
    }
    private static func short(_ value: Any?, _ limit: Int) -> String { String(((value as? String) ?? "").prefix(limit)) }
    static func parse(_ text: String) -> [String: Any]? {
        guard text.utf8.count <= ControllerWire.message else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
    }
    static func json(_ value: [String: Any]) -> String {
        // Slashes as they came: escaped, a message heavy with them could grow past what the apps take.
        String(decoding: (try? JSONSerialization.data(withJSONObject: value, options: .withoutEscapingSlashes)) ?? Data("{}".utf8), as: UTF8.self)
    }
}

import Foundation
import Network

/// One WebSocket the relay has taken (the Network framework speaks the protocol), on the relay's queue. Text goes out at
/// once; a file's pieces wait their turn, one handed to the network at a time, so a button pressed meanwhile never waits
/// behind more than one piece.
final class RelayPeer {
    let connection: NWConnection
    private(set) var open = true
    private(set) var heard = Date()
    /// Text messages not yet handed to the network: how far behind the other end is.
    private(set) var pendingText = 0
    private var pendingTextBytes = 0
    /// Past its handshake: until then a close frame can't go, and only cancelling lets the socket go.
    private var ready = false
    private var queue: DispatchQueue?
    /// Pieces waiting their turn, each with what seals it as it goes, for a wish's room: sealed then, not when queued,
    /// so it takes its number in the order things really go out, after any message sent while it waited.
    private var pieces: [(data: Data, seal: ((Data) -> Data)?)] = []
    private var pieceBytes = 0
    private var sendingPiece = false
    var onText: (String) -> Void = { _ in }
    var onBinary: (Data) -> Void = { _ in }
    var onClose: () -> Void = {}

    /// The most a peer may have waiting to go: every file it can be sent at once, each a window ahead.
    static let pieceLimit = ControllerWire.players * ControllerWire.transfers * (ControllerWire.window + ControllerWire.chunk + ControllerWire.header)
    /// Text a peer that has stopped reading may fall behind by before it's let go, so it can't make the relay hold
    /// everything said to it meanwhile.
    static let textLimit = (messages: 256, bytes: 2 * 1024 * 1024)

    init(connection: NWConnection) {
        self.connection = connection
    }

    func start(on queue: DispatchQueue) {
        self.queue = queue
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: self?.ready = true
            case .failed, .cancelled: self?.closed()
            default: break
            }
        }
        connection.start(queue: queue)
        receive()
    }

    func send(_ text: String) { send(Data(text.utf8), opcode: .text) }

    /// A sealed message of a wish's room (`WishChannel`): binary on the wire, but what text is everywhere else, so it goes
    /// at once and counts as text does towards how far behind the other end is.
    func send(sealed data: Data) { send(data, opcode: .binary) }

    private func send(_ data: Data, opcode: NWProtocolWebSocket.Opcode) {
        guard open else { return }
        guard pendingText < Self.textLimit.messages, pendingTextBytes + data.count <= Self.textLimit.bytes else { return close(code: 4002) }
        pendingText += 1
        pendingTextBytes += data.count
        let context = NWConnection.ContentContext(identifier: "text", metadata: [NWProtocolWebSocket.Metadata(opcode: opcode)])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] _ in
            self?.pendingText -= 1
            self?.pendingTextBytes -= data.count
        })
    }

    /// Queues a piece of a file; false when the peer already has more waiting than it could ever be owed. `seal`, for a
    /// member of a wish's room, seals it as it goes.
    @discardableResult
    func send(piece: Data, seal: ((Data) -> Data)? = nil) -> Bool {
        guard open else { return false }
        guard pieceBytes + piece.count <= Self.pieceLimit else { return false }
        pieces.append((piece, seal))
        pieceBytes += piece.count
        pump()
        return true
    }

    private func pump() {
        guard open, !sendingPiece, !pieces.isEmpty else { return }
        let piece = pieces.removeFirst()
        pieceBytes -= piece.data.count
        sendingPiece = true
        let context = NWConnection.ContentContext(identifier: "piece", metadata: [NWProtocolWebSocket.Metadata(opcode: .binary)])
        connection.send(content: piece.seal?(piece.data) ?? piece.data, contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] _ in
            self?.sendingPiece = false
            self?.pump()
        })
    }

    /// Says why, when the socket can still hear it, and lets it go either way: a close frame can't go before the
    /// handshake, nor to a peer that has stopped reading, and waiting for it to would hold the socket for good.
    func close(code: UInt16 = 1000) {
        guard open else { return }
        let connection = connection
        if ready {
            let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
            metadata.closeCode = code >= 4000 ? .privateCode(code) : (NWProtocolWebSocket.CloseCode.Defined(rawValue: code).map { .protocolCode($0) } ?? .protocolCode(.normalClosure))
            let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
            connection.send(content: nil, contentContext: context, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
            queue?.asyncAfter(deadline: .now() + 2) { connection.cancel() }
        } else {
            connection.cancel()
        }
        closed()
    }

    private func closed() {
        guard open else { return }
        open = false
        pieces = []
        pieceBytes = 0
        onClose()
    }

    private func receive() {
        connection.receiveMessage { [weak self] content, context, _, error in
            guard let self, self.open else { return }
            if error != nil {
                self.connection.cancel()
                return self.closed()
            }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            self.heard = Date()
            switch metadata?.opcode {
            case .text?:
                let data = content ?? Data()
                guard data.count <= ControllerWire.message else { return self.close(code: 1009) }
                self.onText(String(decoding: data, as: UTF8.self))
            case .binary?:
                self.onBinary(content ?? Data())
            case .close?:
                self.connection.cancel()
                return self.closed()
            default:
                break
            }
            if self.open { self.receive() }
        }
    }
}

import Foundation

/// What a TV app and its controllers say to each other, the same on every link: through the relay (`Relay`), and on a
/// link straight to a wish's iPhone app (`LampController` in LampSupport). lamp.js and lamp-controller.js keep the same
/// numbers (`TVTemplate.filesJS`), and LampSupport its own copy.
///
/// Text messages are small JSON: a button, a stick, a message, and a file's start, acknowledgements and end. A file's
/// bytes go as binary messages of at most `chunk` bytes, each behind an 8-byte header: 1, the player it's for or from
/// (the relay's place for a phone; 0 on a direct link), two zero bytes, and the transfer's id (big-endian). The sender
/// sends at most `window` bytes past what the receiver has acknowledged (`file-ack`), so nothing between them ever holds
/// more than that for one file, and a button pressed meanwhile waits behind one piece at most: the relay and the
/// libraries send a piece only once the one before it has gone, and a text message never waits for a piece.
public enum ControllerWire {
    public static let message = 16 * 1024          // bytes, any text message
    public static let chunk = 64 * 1024            // bytes of a file in one binary message
    public static let header = 8
    public static let window = 512 * 1024          // bytes of a file sent ahead of what's acknowledged
    public static let file = 64 * 1024 * 1024      // the largest file
    public static let transfers = 2                // files at once each way, for each phone
    public static let players = 8
    public static let perSecond = 120.0            // messages a phone may send each second, a little over a screen's rate
    public static let backlog = 32                 // messages waiting to go to a TV past which movement is dropped
    public static let silence: TimeInterval = 15
    public static let beat: TimeInterval = 5

    /// The transfer a binary message belongs to, and who it's for or from, when it's well formed.
    public static func chunkHeader(_ data: Data) -> (player: UInt8, id: UInt32)? {
        guard data.count >= header else { return nil }
        let bytes = [UInt8](data.prefix(header))
        guard bytes[0] == 1 else { return nil }
        return (bytes[1], bytes[4...7].reduce(UInt32(0)) { $0 << 8 | UInt32($1) })
    }

    /// The same piece, said to be for or from another player.
    public static func readdressed(_ data: Data, to player: UInt8) -> Data {
        var copy = data
        copy[copy.startIndex + 1] = player
        return copy
    }

    /// Whether a transfer's id is one a library would make: 1 and up, within 31 bits, as JavaScript counts them.
    public static func isID(_ value: Any?) -> UInt32? {
        guard let n = value as? Int, n > 0, n < 1 << 31 else { return nil }
        return UInt32(n)
    }
}

import CryptoKit
import Foundation

/// How a wish's apps prove to each other that they're of the same wish, and then talk where nobody else on the network
/// can read or change what they say. Every app of a wish is given the wish's key when Lamp puts it on its device (32
/// random bytes, one per wish, kept in Lamp's own folder: `WishKeys`); it never travels in clear, and neither does
/// anything that would let someone else in. The relay (`Relay` rooms) is the side that listens; LampSupport.swift,
/// LampSupport.kt and lamp.js are the side that connects, each with its own copy of the same steps, so they must stay
/// byte for byte the same as these (`WishChannelTests` holds them to it).
///
/// The handshake, as JSON text on the socket, every value base64:
///
///   connecting side  {"t":"hello","tag":<8 bytes>,"peer":"tv","nonce":<16 random bytes>}
///   listening side   {"t":"challenge","peer":"lamp","nonce":<16 random bytes>,"proof":<32 bytes>}
///   connecting side  {"t":"proof","proof":<32 bytes>}
///
/// The tag (`tag(for:)`) tells the listener which wish this is without the wish being named on the network. Each proof
/// is an HMAC under the wish's key over everything said so far (`transcript`), with a label for which side made it, so
/// neither can be taken for the other, and both nonces are new each time, so a hello or a whole handshake seen on the
/// network and sent again gets nowhere. The connecting side checks the listener's proof before it sends its own.
///
/// Then each side has a key for what it sends (`keys`), made from the wish's key and the transcript, and everything
/// after the handshake is a binary message: AES-256-GCM under that key, with a nonce that counts the messages sent that
/// way from zero (`Sealer`), so a message can't be read, changed, dropped, sent again or put out of order without the
/// other side noticing, which lets the link go. Inside each is the same JSON the room spoke before (`welcome`, `send`,
/// `message`…); the connecting side's first is `{"t":"join","device":"…"}`. Only beats (`{"t":"beat"}`, every few seconds
/// each way) stay text in clear: they carry nothing, and an app whose socket Lamp holds for it has Lamp beat for it.
///
/// What it doesn't do: every app of the wish has the same key, so a device that has one of the wish's apps can join as
/// any of them; and there is no forward secrecy, so someone who recorded the traffic and later got the key could read it.
public enum WishChannel {
    public static let keySize = 32
    public static let tagSize = 8
    public static let nonceSize = 16
    /// What the relay calls itself in a handshake, as the listening side.
    public static let relayName = "lamp"
    /// The most a sealed message may hold: one message between the wish's apps, and its seal.
    public static let sealedLimit = ControllerWire.message + 1024
    /// The bytes of a file in one piece between a wish's apps.
    public static let pieceSize = ControllerWire.chunk
    /// The most a sealed piece of a file may hold: a piece's bytes behind its header (`piece`).
    public static let pieceLimit = pieceSize + 64

    /// A piece of a file between a wish's apps, as it goes sealed: 1, the length of a peer's name and the name (the one it's
    /// for, from its sender to the relay; the one it's from, from the relay; none on a link straight between two apps),
    /// the transfer's id as its sender numbers it (4 bytes, big-endian), then the bytes. A message is JSON and starts
    /// with "{", so the first byte tells the two apart. What the file is, its acknowledgements and its end are messages
    /// (`file`, `file-ack`, `file-refuse`, `file-cancel`), and its flow is the controllers' (`ControllerWire`).
    public static func piece(peer: String, id: UInt32, bytes: Data) -> Data {
        var data = Data([1, UInt8(peer.utf8.count)])
        data.append(Data(peer.utf8))
        data.append(contentsOf: [UInt8(id >> 24 & 0xff), UInt8(id >> 16 & 0xff), UInt8(id >> 8 & 0xff), UInt8(id & 0xff)])
        data.append(bytes)
        return data
    }

    /// A piece's peer, transfer and where its bytes start, when it's well formed.
    public static func pieceHeader(_ data: Data) -> (peer: String, id: UInt32, offset: Int)? {
        let bytes = [UInt8](data.prefix(2 + 32 + 4))
        guard bytes.count >= 2, bytes[0] == 1, bytes[1] <= 32, bytes.count >= 2 + Int(bytes[1]) + 4 else { return nil }
        let n = Int(bytes[1])
        let name = String(decoding: bytes[2..<(2 + n)], as: UTF8.self)
        guard n == 0 || isName(name) else { return nil }
        let id = bytes[(2 + n)..<(2 + n + 4)].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        return (name, id, 2 + n + 4)
    }

    /// HMAC-SHA256 under the wish's key of a label, a zero byte and what it's about: every value the channel derives.
    public static func derive(_ label: String, key: SymmetricKey, _ data: Data = Data()) -> Data {
        var message = Data(label.utf8)
        message.append(0)
        message.append(data)
        return Data(HMAC<SHA256>.authenticationCode(for: message, using: key))
    }

    /// Which wish this is, as the listener knows it: the first 8 bytes of a value only the wish's key makes.
    public static func tag(for key: SymmetricKey) -> Data { derive("lamp-wish tag", key: key).prefix(tagSize) }

    /// A peer's name, as it may be in a handshake: Lamp's folder names, lowercased, each copy of an app with its own id
    /// after a dot ("screen.k3j9x0ab"), at most 32 bytes in all. An app built before copies says its name alone.
    public static func isName(_ name: String) -> Bool {
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...32).contains(name.utf8.count), (1...2).contains(parts.count), !parts.contains(where: \.isEmpty) else { return false }
        return parts[0].utf8.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2d }
            && parts.dropFirst().allSatisfy { $0.utf8.allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) } }
    }

    /// Which app a peer is a copy of: its name before the copy's id.
    public static func app(of peer: String) -> String { peer.split(separator: ".", maxSplits: 1).first.map(String.init) ?? peer }

    /// Everything the handshake has said, in one order: the tag, each side's name with its length before it, and both nonces.
    public static func transcript(tag: Data, client: String, server: String, clientNonce: Data, serverNonce: Data) -> Data {
        var data = tag
        for name in [client, server] {
            data.append(UInt8(name.utf8.count))
            data.append(Data(name.utf8))
        }
        data.append(clientNonce)
        data.append(serverNonce)
        return data
    }

    public static func serverProof(key: SymmetricKey, transcript: Data) -> Data { derive("lamp-wish server", key: key, transcript) }
    public static func clientProof(key: SymmetricKey, transcript: Data) -> Data { derive("lamp-wish client", key: key, transcript) }

    /// The keys each side seals with: what the connecting side sends, and what the listening side sends.
    public static func keys(key: SymmetricKey, transcript: Data) -> (client: SymmetricKey, server: SymmetricKey) {
        (SymmetricKey(data: derive("lamp-wish c2s", key: key, transcript)), SymmetricKey(data: derive("lamp-wish s2c", key: key, transcript)))
    }

    /// Two values compared in a time that doesn't depend on where they differ.
    public static func same(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    public static func random(_ count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: 0...255, using: &generator) })
    }

    /// One direction of a link: seals what goes, or opens what comes, the nth message with nonce n.
    public struct Sealer: Sendable {
        let key: SymmetricKey
        public private(set) var count: UInt64 = 0
        public init(key: SymmetricKey) { self.key = key }

        static func nonce(_ count: UInt64) -> AES.GCM.Nonce {
            var bytes = Data(repeating: 0, count: 4)
            withUnsafeBytes(of: count.bigEndian) { bytes.append(contentsOf: $0) }
            return try! AES.GCM.Nonce(data: bytes)
        }

        /// The message sealed: what was sent, then its 16-byte tag.
        public mutating func seal(_ plain: Data) -> Data {
            defer { count += 1 }
            let box = try! AES.GCM.seal(plain, using: key, nonce: Self.nonce(count))
            return box.ciphertext + box.tag
        }

        /// What a sealed message said, when it's the next one this way and nothing in it was changed; nil otherwise.
        public mutating func open(_ sealed: Data) -> Data? {
            guard sealed.count >= 16, sealed.count <= max(sealedLimit, pieceLimit) + 16,
                  let box = try? AES.GCM.SealedBox(nonce: Self.nonce(count), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16)),
                  let plain = try? AES.GCM.open(box, using: key) else { return nil }
            count += 1
            return plain
        }
    }
}

import CryptoKit
import Foundation

/// Lamp on the Mac as a keeper of a wish's shared collections (`LampStore.shared`, the wish's own, and shared files): a
/// member of the wish's room under the relay's own name (`WishChannel.relayName`, "lamp"), which no app of a wish may
/// take, that keeps every collection the copies share and speaks the copies' own `store` messages (`items`, `sum`, `ask`,
/// `file`), so a copy that opens while no other is open still gets the latest, and what it changes while only Lamp is
/// there reaches the others when they open. It never sets an item itself: it merges what copies send by their rules
/// (item by item, the latest setting winning, a deletion kept a month) and answers with what it has, so a copy that
/// meets it is as if it met the copy that set each item.
///
/// It isn't an app of the wish: it's never in the room's list or its members, so no app counts it among its copies or
/// apps; the room's `welcome` says it keeps (`keeps`), and a copy that speaks 7 or more (`wire`) then counts it among
/// those it shares collections with, all of them, an app's own by that app (`scope`) and the wish's own together. An
/// older copy never hears from it; what such copies send each other through the room is kept all the same.
///
/// What it keeps is in Lamp's own folder (the room's `keep`, by the wish's tag), sealed with a key from the wish's key,
/// so it reads as nothing without the key, which is kept apart (`WishKeys`). It runs on the relay's queue, as the room does.
final class WishKeeper {
    /// The first wire that knows Lamp keeps: only such a copy is sent anything.
    static let wire = 7
    static let itemLimit = 8 * 1024
    static let sharedLimit = 1024 * 1024
    static let filesLimit = 256 * 1024 * 1024
    static let collectionsLimit = 32
    static let removalsKept: Int64 = 30 * 24 * 3600 * 1000
    /// The wish's own collections, as a scope: every other scope is one app's, by its name.
    static let wishWide = "*"

    struct Entry {
        var value: Any?
        var ms: Int64
        var n: Int
        var peer: String
        func isLater(than other: Entry) -> Bool { (ms, n, peer) > (other.ms, other.n, other.peer) }
        var json: [String: Any] {
            var json: [String: Any] = ["c": [ms, n, peer]]
            if let value { json["v"] = value }
            return json
        }
        /// As the libraries take one: whole numbers in range only, as every language reads them.
        init?(_ json: Any?) {
            guard let json = json as? [String: Any], let c = json["c"] as? [Any], c.count == 3,
                  let ms = Self.whole(c[0]), let n = Self.whole(c[1]), let peer = c[2] as? String,
                  ms <= 1 << 50, n <= 1_000_000, peer.utf8.count <= 32 else { return nil }
            self.ms = ms
            self.n = Int(n)
            self.peer = peer
            self.value = json["v"].flatMap { $0 is NSNull ? nil : $0 }
        }
        private static func whole(_ value: Any) -> Int64? {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), !CFNumberIsFloatType(number),
                  number.int64Value >= 0 else { return nil }
            return number.int64Value
        }
    }

    struct Item {
        var entry: Entry
        /// What it takes of the scope's room: its id, and its value as JSON or at least 32 bytes, which a deletion takes.
        var held: Int
    }

    private final class Incoming {
        let scope: String, name: String, id: String, sum: String, size: Int
        var data = Data()
        var moved = Date()
        init(scope: String, name: String, id: String, sum: String, size: Int) {
            self.scope = scope; self.name = name; self.id = id; self.sum = sum; self.size = size
        }
    }

    private final class Outgoing {
        let bytes: Data
        var offset = 0
        var acknowledged = 0
        var moved = Date()
        init(bytes: Data) { self.bytes = bytes }
    }

    let folder: URL
    private let sealing: SymmetricKey
    /// Each scope's collections, by name, then each item by id: read from disk the first time it's needed.
    private var scopes: [String: [String: [String: Item]]] = [:]
    private var unsaved: Set<String> = []
    private var saving = false
    private var closed = false
    private let queue: DispatchQueue
    private var incoming: [String: Incoming] = [:]
    private var outgoing: [String: Outgoing] = [:]
    /// The files asked of each copy for, each by scope, collection and id: whom and when.
    private var fileAsks: [String: (copy: String, at: Date)] = [:]
    private var fileTries: [String: Int] = [:]
    private var nextFile: UInt32 = 1
    private var beats = 0

    /// How many apps the wish has, which bounds what's held from them as each copy's library bounds it.
    var appCount = 1
    /// Says a `store` or file message to one copy, as from Lamp (the room seals it); nothing for a copy not in the room.
    var send: (_ copy: String, _ message: [String: Any]) -> Void = { _, _ in }
    /// Hands one copy a piece of a file (`WishChannel.piece`, from Lamp); false when it can't take more now.
    var sendPiece: (_ copy: String, _ piece: Data) -> Bool = { _, _ in false }
    /// The copies in the room now, with what each speaks.
    var present: () -> [String: Int] = { [:] }

    init(folder: URL, key: SymmetricKey, queue: DispatchQueue) {
        self.folder = folder
        self.queue = queue
        sealing = SymmetricKey(data: WishChannel.derive("lamp-wish keep", key: key))
    }

    // MARK: From the room

    /// A copy came into the room: told what each of its collections adds up to here, so it asks for what it lacks, and
    /// asked for the files Lamp lacks.
    func joined(_ copy: String, wire: Int) {
        guard wire >= Self.wire, !closed else { return }
        sendSums(to: copy)
        fetchFiles()
    }

    func left(_ copy: String) {
        incoming = incoming.filter { !$0.key.hasPrefix(copy + "\t") }
        outgoing = outgoing.filter { !$0.key.hasPrefix(copy + "\t") }
        for (key, ask) in fileAsks where ask.copy == copy { fileAsks[key] = nil }
        fetchFiles()
    }

    /// A copy's `store` message to Lamp.
    func heard(_ m: [String: Any], from copy: String) {
        guard !closed, WishChannel.isName(copy) else { return }
        switch m["op"] as? String {
        case "items":
            guard let name = m["s"] as? String, Self.isCollection(name), let given = m["items"] as? [String: Any] else { return }
            merge(scope(of: name, copy: copy), name, given)
        case "sum":
            var asks: [String: [Int]] = [:]
            for (name, sum) in m["sums"] as? [String: String] ?? [:] where Self.isCollection(name) {
                let mine = sums(scope(of: name, copy: copy), name)
                let parts = Self.parts(sum)
                let differ = (0..<16).filter { parts[$0] != 0 && parts[$0] != mine[$0] }
                if !differ.isEmpty { asks[name] = differ }
            }
            for batch in Self.batches(asks) { send(copy, ["t": "store", "op": "ask", "asks": batch]) }
        case "ask":
            for (name, buckets) in m["asks"] as? [String: [Int]] ?? [:] where Self.isCollection(name) {
                let wanted = Set(buckets)
                let list = (collections(scope(of: name, copy: copy))[name] ?? [:]).filter { wanted.contains(Int(Self.fnv($0.key) & 15)) }
                if !list.isEmpty { shareItems(name, list.mapValues(\.entry), to: copy) }
            }
        case "file":
            guard let name = m["s"] as? String, name.hasPrefix("files:"), Self.isCollection(name), let id = m["id"] as? String,
                  let sum = m["sum"] as? String else { return }
            sendFile(scope(of: name, copy: copy), name, id: id, sum: sum, to: copy)
        default:
            break
        }
    }

    /// Items one copy sent another through the room: kept as if sent to Lamp, so what copies that don't know Lamp keeps
    /// (an older copy) say to each other is kept too.
    func overheard(_ m: [String: Any], from copy: String) {
        guard !closed, m["op"] as? String == "items", let name = m["s"] as? String, Self.isCollection(name),
              let given = m["items"] as? [String: Any] else { return }
        merge(scope(of: name, copy: copy), name, given)
    }

    /// Every few seconds, from the relay's beat: once a minute each copy that knows Lamp keeps is told its sums again,
    /// a file asked for and not come is asked again, and a file that stopped moving ends.
    func tick() {
        guard !closed else { return }
        let now = Date()
        for (key, file) in incoming where now.timeIntervalSince(file.moved) > 20 {
            incoming[key] = nil
            if let (copy, id) = Self.split(key) { send(copy, ["t": "file-refuse", "id": id, "reason": "The file stopped moving."]) }
        }
        for (key, file) in outgoing where now.timeIntervalSince(file.moved) > 20 {
            outgoing[key] = nil
            if let (copy, id) = Self.split(key) { send(copy, ["t": "file-cancel", "id": id]) }
        }
        beats += 1
        if beats % 12 == 0 { for (copy, wire) in present() where wire >= Self.wire { sendSums(to: copy) } }
        if beats % 12 == 6 { fetchFiles() }
    }

    /// The room is over: what's unsaved is written now, and nothing more is.
    func close() {
        save()
        closed = true
    }

    /// The wish is gone: everything kept for it goes.
    func forget() {
        closed = true
        scopes = [:]
        unsaved = []
        try? FileManager.default.removeItem(at: folder)
    }

    // MARK: Collections

    /// Which scope a copy's collection is in: the wish's own, or the copy's app's own.
    private func scope(of name: String, copy: String) -> String {
        Self.isWishWide(name) ? Self.wishWide : WishChannel.app(of: copy)
    }

    private func collections(_ scope: String) -> [String: [String: Item]] {
        if let kept = scopes[scope] { return kept }
        var list: [String: [String: Item]] = [:]
        if let sealed = try? Data(contentsOf: scopeURL(scope)), let box = try? AES.GCM.SealedBox(combined: sealed),
           let plain = try? AES.GCM.open(box, using: sealing),
           let kept = (try? JSONSerialization.jsonObject(with: plain)) as? [String: [String: Any]] {
            for (name, items) in kept where Self.isCollection(name) {
                for (id, json) in items where Self.isItemID(id) {
                    guard let entry = Entry(json) else { continue }
                    list[name, default: [:]][id] = Item(entry: entry, held: Self.held(id, entry))
                }
            }
        }
        scopes[scope] = list
        dropExpired(scope)
        return scopes[scope] ?? [:]
    }

    /// Items a copy sent, each taken when it's later than what Lamp has, so whatever order they come in it ends with the
    /// same as every copy. What a scope holds is bounded as a copy bounds what it holds from others: twice what every app
    /// of the wish could set, the oldest deletions let go first when a flood needs room.
    private func merge(_ scope: String, _ name: String, _ given: [String: Any]) {
        var all = collections(scope)
        guard all[name] != nil || all.count < Self.collectionsLimit * 2 else { return }
        let most = Self.sharedLimit * 2 * max(2, appCount)
        var held = all.values.reduce(0) { $0 + $1.values.reduce(0) { $0 + $1.held } }
        var removals: [(String, String)]? = nil, next = 0
        func oldestRemoval(except id: String) -> (String, String)? {
            if removals == nil {
                removals = all.flatMap { name, list in list.filter { $0.value.entry.value == nil }.map { (name, $0.key, $0.value.entry) } }
                    .sorted { $1.2.isLater(than: $0.2) }.map { ($0.0, $0.1) }
            }
            while let list = removals, next < list.count {
                let each = list[next]
                next += 1
                if each != (name, id), all[each.0]?[each.1]?.entry.value == nil { return each }
            }
            return nil
        }
        let old = Int64(Date().timeIntervalSince1970 * 1000) - Self.removalsKept
        var changed: [String] = []
        for (id, json) in given.sorted(by: { $0.key < $1.key }) {
            guard Self.isItemID(id), let entry = Entry(json) else { continue }
            let had = all[name]?[id]
            if let had, !entry.isLater(than: had.entry) { continue }
            let size = entry.value.map(Self.size(of:)) ?? 32
            if size > Self.itemLimit * 2 { continue }
            let need = id.utf8.count + max(32, size)
            // A deletion too old to keep, or with no room left to keep it, still deletes; a value with no room is left.
            func dropOnly() {
                guard entry.value == nil, let had = all[name]?.removeValue(forKey: id) else { return }
                held -= had.held
                changed.append(id)
            }
            if entry.value == nil, entry.ms < old { dropOnly(); continue }
            while held - (had?.held ?? 0) + need > most, let gone = oldestRemoval(except: id), let removal = all[gone.0]?.removeValue(forKey: gone.1) {
                held -= removal.held
            }
            if held - (had?.held ?? 0) + need > most { dropOnly(); continue }
            held += need - (had?.held ?? 0)
            all[name, default: [:]][id] = Item(entry: entry, held: need)
            changed.append(id)
        }
        all = all.filter { !$0.value.isEmpty }
        scopes[scope] = all
        unsaved.insert(scope)
        saveSoon()
        if name.hasPrefix("files:") {
            for id in changed { dropStaleBytes(scope, name, id: id) }
            if !changed.isEmpty { fetchFiles() }
        }
    }

    private func dropExpired(_ scope: String) {
        let old = Int64(Date().timeIntervalSince1970 * 1000) - Self.removalsKept
        guard let all = scopes[scope], all.values.contains(where: { $0.values.contains { $0.entry.value == nil && $0.entry.ms <= old } }) else { return }
        scopes[scope] = all.mapValues { $0.filter { $0.value.entry.value != nil || $0.value.entry.ms > old } }.filter { !$0.value.isEmpty }
        unsaved.insert(scope)
        saveSoon()
    }

    /// Sends items to a copy a few at a time, so each message stays within what a message may be.
    private func shareItems(_ name: String, _ list: [String: Entry], to copy: String) {
        var batch: [String: Any] = [:], size = 0
        func flush() {
            guard !batch.isEmpty else { return }
            send(copy, ["t": "store", "op": "items", "s": name, "items": batch])
            batch = [:]
            size = 0
        }
        for (id, entry) in list.sorted(by: { $0.key < $1.key }) {
            let json = entry.json
            let bytes = Self.json([id: json])?.count ?? 0
            if size + bytes > 12 * 1024 { flush() }
            batch[id] = json
            size += bytes
        }
        flush()
    }

    /// Tells a copy what each sixteenth of each collection it shares adds up to here: its app's own and the wish's own.
    private func sendSums(to copy: String) {
        var said: [String: String] = [:]
        for scope in [WishChannel.app(of: copy), Self.wishWide] {
            for (name, list) in collections(scope) where !list.isEmpty {
                said[name] = sums(scope, name).map { String(format: "%08x", $0) }.joined()
            }
        }
        for batch in Self.batches(said) { send(copy, ["t": "store", "op": "sum", "sums": batch]) }
    }

    private func sums(_ scope: String, _ name: String) -> [UInt32] {
        var parts = [UInt32](repeating: 0, count: 16)
        for (id, item) in collections(scope)[name] ?? [:] {
            parts[Int(Self.fnv(id) & 15)] ^= Self.fnv("\(id)\u{0}\(item.entry.ms)\u{0}\(item.entry.n)\u{0}\(item.entry.peer)")
        }
        return parts
    }

    // MARK: Shared files

    private func bytesURL(_ scope: String, _ name: String, id: String, sum: String) -> URL {
        folder.appendingPathComponent("files").appendingPathComponent(Self.hex(Data(SHA256.hash(data: Data("\(scope)\u{0}\(name)\u{0}\(id)".utf8))).prefix(16)) + "-" + sum)
    }

    private func hasBytes(_ scope: String, _ name: String, id: String, sum: String) -> Bool {
        FileManager.default.fileExists(atPath: bytesURL(scope, name, id: id, sum: sum).path)
    }

    private func dropStaleBytes(_ scope: String, _ name: String, id: String) {
        let sum = (collections(scope)[name]?[id]?.entry.value as? [String: Any])?["sum"] as? String
        let prefix = bytesURL(scope, name, id: id, sum: "").lastPathComponent
        let files = folder.appendingPathComponent("files")
        for each in (try? FileManager.default.contentsOfDirectory(atPath: files.path)) ?? [] where each.hasPrefix(prefix) && each != prefix + (sum ?? "") {
            try? FileManager.default.removeItem(at: files.appendingPathComponent(each))
        }
    }

    /// Asks a copy for each shared file Lamp lacks: the one that set it first, then each other in turn, two at a time of
    /// each, again after a minute without them.
    private func fetchFiles() {
        let open = present().filter { $0.value >= Self.wire }.keys.sorted()
        guard !open.isEmpty, !closed else { return }
        let now = Date()
        for (scope, all) in scopes.sorted(by: { $0.key < $1.key }) {
            let sources = open.filter { scope == Self.wishWide || WishChannel.app(of: $0) == scope }
            guard !sources.isEmpty else { continue }
            var here = 0
            for (name, list) in all where name.hasPrefix("files:") {
                for (id, item) in list {
                    guard let meta = item.entry.value as? [String: Any], let sum = meta["sum"] as? String, let size = meta["size"] as? Int,
                          hasBytes(scope, name, id: id, sum: sum) else { continue }
                    here += size
                }
            }
            for (name, list) in all.sorted(by: { $0.key < $1.key }) where name.hasPrefix("files:") {
                for (id, item) in list.sorted(by: { $0.key < $1.key }) {
                    guard let meta = item.entry.value as? [String: Any], let sum = meta["sum"] as? String, let size = meta["size"] as? Int,
                          size <= ControllerWire.file else { continue }
                    let key = scope + "\t" + name + "\t" + id
                    if hasBytes(scope, name, id: id, sum: sum) { fileAsks[key] = nil; fileTries[key] = nil; continue }
                    if let ask = fileAsks[key], sources.contains(ask.copy), now.timeIntervalSince(ask.at) < 60 { continue }
                    guard here + size <= Self.filesLimit * 2 else { break }
                    let tries = fileTries[key] ?? 0
                    let order = sources.contains(item.entry.peer) ? [item.entry.peer] + sources.filter { $0 != item.entry.peer } : sources
                    let source = order[tries % order.count]
                    guard fileAsks.values.filter({ $0.copy == source && now.timeIntervalSince($0.at) < 60 }).count < 2 else { continue }
                    fileTries[key] = tries + 1
                    fileAsks[key] = (source, now)
                    here += size
                    send(source, ["t": "store", "op": "file", "s": name, "id": id, "sum": sum])
                }
            }
        }
    }

    /// A copy sending Lamp a file's bytes it asked for: taken only for a shared file Lamp has as that size and lacks.
    func fileStarts(_ m: [String: Any], from copy: String) {
        guard !closed, let id = ControllerWire.isID(m["id"]) else { return }
        let key = "\(copy)\t\(id)"
        let channel = m["ch"] as? String ?? ""
        let name = String(channel.dropFirst(6))
        let item = m["name"] as? String ?? ""
        let scope = scope(of: name, copy: copy)
        guard channel.hasPrefix("store:files:"), Self.isCollection(name), let size = m["size"] as? Int, size >= 0, size <= ControllerWire.file,
              incoming[key] == nil, incoming.keys.filter({ $0.hasPrefix(copy + "\t") }).count < ControllerWire.transfers,
              let meta = collections(scope)[name]?[item]?.entry.value as? [String: Any], meta["size"] as? Int == size,
              let sum = meta["sum"] as? String, !hasBytes(scope, name, id: item, sum: sum) else {
            return send(copy, ["t": "file-refuse", "id": id, "reason": "Lamp doesn't need that file now."])
        }
        let file = Incoming(scope: scope, name: name, id: item, sum: sum, size: size)
        incoming[key] = file
        if size == 0 { finish(key, file, from: copy, id: id) }
    }

    func piece(_ bytes: Data, id: UInt32, from copy: String) {
        let key = "\(copy)\t\(id)"
        guard let file = incoming[key] else { return }
        guard file.data.count + bytes.count <= file.size else {
            incoming[key] = nil
            return send(copy, ["t": "file-refuse", "id": id, "reason": "The file was bigger than it said."])
        }
        file.data.append(bytes)
        file.moved = Date()
        send(copy, ["t": "file-ack", "id": id, "got": file.data.count])
        if file.data.count == file.size { finish(key, file, from: copy, id: id) }
    }

    private func finish(_ key: String, _ file: Incoming, from copy: String, id: UInt32) {
        incoming[key] = nil
        if file.size == 0 { send(copy, ["t": "file-ack", "id": id, "got": 0]) }
        fileAsks[file.scope + "\t" + file.name + "\t" + file.id] = nil
        guard Self.checksum(file.data) == file.sum, let sealed = try? AES.GCM.seal(file.data, using: sealing).combined else { return fetchFiles() }
        let url = bytesURL(file.scope, file.name, id: file.id, sum: file.sum)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard Self.write(sealed, to: url) else { return }
        fileTries[file.scope + "\t" + file.name + "\t" + file.id] = nil
        dropStaleBytes(file.scope, file.name, id: file.id)
        fetchFiles()
    }

    func fileEnded(_ m: [String: Any], from copy: String) {
        guard let id = ControllerWire.isID(m["id"]) else { return }
        let key = "\(copy)\t\(id)"
        switch m["t"] as? String {
        case "file-ack":
            guard let file = outgoing[key], let got = m["got"] as? Int, got >= file.acknowledged, got <= file.offset else { return }
            file.acknowledged = got
            file.moved = Date()
            if got == file.bytes.count { outgoing[key] = nil } else { pump(key, to: copy) }
        case "file-refuse":
            outgoing[key] = nil
        case "file-cancel":
            incoming[key] = nil
        default:
            break
        }
    }

    /// A copy asked for a shared file's bytes: sent when Lamp has them as the file is now, two at a time to each copy.
    private func sendFile(_ scope: String, _ name: String, id: String, sum: String, to copy: String) {
        guard let meta = collections(scope)[name]?[id]?.entry.value as? [String: Any], meta["sum"] as? String == sum,
              outgoing.keys.filter({ $0.hasPrefix(copy + "\t") }).count < ControllerWire.transfers,
              let sealed = try? Data(contentsOf: bytesURL(scope, name, id: id, sum: sum)),
              let box = try? AES.GCM.SealedBox(combined: sealed), let bytes = try? AES.GCM.open(box, using: sealing),
              Self.checksum(bytes) == sum else { return }
        let fileID = nextFile
        nextFile = nextFile >= UInt32(Int32.max) - 1 ? 1 : nextFile + 1
        let key = "\(copy)\t\(fileID)"
        outgoing[key] = Outgoing(bytes: bytes)
        send(copy, ["t": "file", "id": Int(fileID), "name": id, "type": String((meta["type"] as? String ?? "").prefix(100)),
                    "size": bytes.count, "ch": "store:" + name])
        pump(key, to: copy)
    }

    /// A file's next pieces, never more than a window past what the copy has acknowledged.
    private func pump(_ key: String, to copy: String) {
        guard let file = outgoing[key], let (_, id) = Self.split(key) else { return }
        while file.offset < file.bytes.count, file.offset - file.acknowledged < ControllerWire.window {
            let count = min(ControllerWire.chunk, file.bytes.count - file.offset)
            let piece = WishChannel.piece(peer: WishChannel.relayName, id: id, bytes: file.bytes.subdata(in: file.offset..<(file.offset + count)))
            guard sendPiece(copy, piece) else { break }
            file.offset += count
        }
    }

    // MARK: Kept on disk

    private func scopeURL(_ scope: String) -> URL {
        folder.appendingPathComponent(Self.hex(Data(SHA256.hash(data: Data(scope.utf8))).prefix(16)) + ".kept")
    }

    /// Written a moment after a change, so a burst of them is written once.
    private func saveSoon() {
        guard !saving, !closed else { return }
        saving = true
        queue.asyncAfter(deadline: .now() + 1) { [weak self] in self?.save() }
    }

    private func save() {
        saving = false
        guard !closed else { return }
        for scope in unsaved {
            let url = scopeURL(scope)
            let list = scopes[scope] ?? [:]
            if list.isEmpty { try? FileManager.default.removeItem(at: url); continue }
            guard let plain = Self.json(list.mapValues { $0.mapValues(\.entry.json) }),
                  let sealed = try? AES.GCM.seal(plain, using: sealing).combined else { continue }
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            Self.write(sealed, to: url)
        }
        unsaved = []
    }

    /// Written whole, readable by this account alone.
    @discardableResult
    private static func write(_ data: Data, to url: URL) -> Bool {
        guard (try? data.write(to: url, options: .atomic)) != nil else { return false }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return true
    }

    // MARK: As the libraries have them

    static func isCollection(_ name: String) -> Bool {
        var plain = name.hasPrefix("files:") ? String(name.dropFirst(6)) : name
        if plain.hasPrefix("wish:") { plain = String(plain.dropFirst(5)) }
        return (1...64).contains(plain.utf8.count) && plain != "__proto__" && plain.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "-_.".contains($0)) }
    }
    static func isWishWide(_ name: String) -> Bool { (name.hasPrefix("files:") ? String(name.dropFirst(6)) : name).hasPrefix("wish:") }
    static func isItemID(_ id: String) -> Bool { (1...128).contains(id.utf8.count) && id != "__proto__" }
    static func size(of value: Any) -> Int {
        ((try? JSONSerialization.data(withJSONObject: [value], options: .withoutEscapingSlashes)).map(\.count) ?? 2) - 2
    }
    static func held(_ id: String, _ entry: Entry) -> Int { id.utf8.count + max(32, entry.value.map(size(of:)) ?? 32) }
    static func fnv(_ text: String) -> UInt32 {
        var hash: UInt32 = 2166136261
        for byte in text.utf8 { hash = (hash ^ UInt32(byte)) &* 16777619 }
        return hash
    }
    static func parts(_ sum: String) -> [UInt32] {
        let chars = Array(sum.utf8)
        guard chars.count == 128 else { return [UInt32](repeating: 0, count: 16) }
        return (0..<16).map { UInt32(String(decoding: chars[($0 * 8)..<($0 * 8 + 8)], as: UTF8.self), radix: 16) ?? 0 }
    }
    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
    static func checksum(_ data: Data) -> String { hex(Data(SHA256.hash(data: data)).prefix(16)) }
    static func json(_ object: Any) -> Data? { try? JSONSerialization.data(withJSONObject: object, options: .withoutEscapingSlashes) }
    private static func split(_ key: String) -> (String, UInt32)? {
        let parts = key.split(separator: "\t")
        guard parts.count == 2, let id = UInt32(parts[1]) else { return nil }
        return (String(parts[0]), id)
    }
    /// A map split so each part stays within a message, as sums and asks for many collections can't go in one.
    private static func batches<T>(_ map: [String: T]) -> [[String: T]] {
        var out: [[String: T]] = [], batch: [String: T] = [:], size = 0
        for (name, value) in map.sorted(by: { $0.key < $1.key }) {
            let bytes = (json([name: value])?.count ?? 0)
            if size + bytes > 12 * 1024, !batch.isEmpty { out.append(batch); batch = [:]; size = 0 }
            batch[name] = value
            size += bytes
        }
        if !batch.isEmpty { out.append(batch) }
        return out
    }
}

#endif
