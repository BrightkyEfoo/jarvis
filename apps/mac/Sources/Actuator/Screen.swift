import AppKit
import ApplicationServices
import Carbon.HIToolbox
import ScreenCaptureKit

/// Any app, visually: a screenshot of its front window plus its labelled controls (accessibility
/// tree), then real clicks and keystrokes. Coordinates are those of the last screenshot.
final class ScreenActor {
    private struct Shot {
        let pid: pid_t
        let frame: CGRect // screen points, top-left origin
        let width: Int
        let height: Int
        var elements: [Int: CGPoint] // id → screen point
    }

    private var shots: [pid_t: Shot] = [:]
    private var lastProbe: (pid: pid_t, point: CGPoint, label: String)?
    private var promptedAX = false
    private var promptedCapture = false
    static let maxEdge: CGFloat = 1568

    // MARK: permissions

    private func requireAccessibility() throws {
        if AXIsProcessTrusted() { return }
        if !promptedAX {
            promptedAX = true
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        }
        throw ActGuard.Refused(message: "Autorise Jarvis dans Réglages Système › Confidentialité et sécurité › Accessibilité")
    }

    private func requireCapture() throws {
        if CGPreflightScreenCaptureAccess() { return }
        if !promptedCapture {
            promptedCapture = true
            _ = CGRequestScreenCaptureAccess()
        }
        throw ActGuard.Refused(message: "Autorise Jarvis dans Réglages Système › Confidentialité et sécurité › Enregistrement de l'écran")
    }

    // MARK: apps and windows

    func resolve(_ name: String?) throws -> NSRunningApplication {
        let app: NSRunningApplication?
        if let name {
            let n = name.lowercased().replacingOccurrences(of: ".app", with: "").trimmingCharacters(in: .whitespaces)
            app = NSWorkspace.shared.runningApplications.first { a in
                a.activationPolicy == .regular && (
                    a.localizedName?.lowercased() == n ||
                    a.bundleURL?.deletingPathExtension().lastPathComponent.lowercased() == n ||
                    a.bundleIdentifier?.lowercased() == n)
            }
            if app == nil { throw ActGuard.Refused(message: "\(name) n'est pas ouvert (ouvre-le d'abord avec app_open)") }
        } else {
            app = NSWorkspace.shared.frontmostApplication
        }
        guard let app else { throw ActGuard.Refused(message: "aucune app au premier plan") }
        try ActGuard.check(app: app)
        return app
    }

    private func frontWindow(of pid: pid_t) -> (id: CGWindowID, frame: CGRect, title: String)? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for w in list { // front to back
            guard (w[kCGWindowOwnerPID as String] as? pid_t) == pid, (w[kCGWindowLayer as String] as? Int) == 0,
                  let b = w[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: b),
                  frame.width > 60, frame.height > 60, let id = w[kCGWindowNumber as String] as? CGWindowID else { continue }
            return (id, frame, w[kCGWindowName as String] as? String ?? "")
        }
        return nil
    }

    private func activate(_ app: NSRunningApplication) throws {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return }
        app.activate()
        for _ in 0..<30 {
            Thread.sleep(forTimeInterval: 0.05)
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return }
        }
        throw ActGuard.Refused(message: "impossible d'amener \(app.localizedName ?? "l'app") au premier plan")
    }

    // MARK: look

    func look(app name: String?, cancel: CancelToken) throws -> [String: Any] {
        try requireCapture()
        try requireAccessibility()
        let app = try resolve(name)
        var win = frontWindow(of: app.processIdentifier)
        if win == nil {
            try activate(app)
            Thread.sleep(forTimeInterval: 0.3)
            win = frontWindow(of: app.processIdentifier)
        }
        guard let win else { throw ActGuard.Refused(message: "\(app.localizedName ?? "l'app") n'a pas de fenêtre visible") }
        try cancel.check()

        let image = try blocking { () async throws -> CGImage in
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let w = content.windows.first(where: { $0.windowID == win.id }) else {
                throw ActGuard.Refused(message: "fenêtre introuvable pour la capture")
            }
            let filter = SCContentFilter(desktopIndependentWindow: w)
            let scale = CGFloat(filter.pointPixelScale)
            let px = CGSize(width: win.frame.width * scale, height: win.frame.height * scale)
            let k = min(1, Self.maxEdge / max(px.width, px.height))
            let cfg = SCStreamConfiguration()
            cfg.width = Int(px.width * k)
            cfg.height = Int(px.height * k)
            cfg.showsCursor = false
            cfg.ignoreShadowsSingleWindow = true
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        }
        guard let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else {
            throw ActGuard.Refused(message: "encodage JPEG impossible")
        }

        var shot = Shot(pid: app.processIdentifier, frame: win.frame, width: image.width, height: image.height, elements: [:])
        var listed: [[String: Any]] = []
        for (i, e) in elements(pid: app.processIdentifier, within: win.frame).enumerated() {
            let id = i + 1
            shot.elements[id] = e.center
            let p = toImage(e.center, shot)
            listed.append(["id": id, "role": e.role, "label": e.label, "secure": e.secure, "x": Int(p.x), "y": Int(p.y)])
        }
        shots[app.processIdentifier] = shot
        return ["app": app.localizedName ?? "?", "window": win.title, "width": image.width, "height": image.height,
                "image": jpeg.base64EncodedString(), "elements": listed]
    }

    private func toImage(_ p: CGPoint, _ s: Shot) -> CGPoint {
        CGPoint(x: (p.x - s.frame.minX) * CGFloat(s.width) / s.frame.width,
                y: (p.y - s.frame.minY) * CGFloat(s.height) / s.frame.height)
    }

    private func toScreen(element: Int?, x: Int?, y: Int?, _ s: Shot) throws -> CGPoint {
        if let element {
            guard let p = s.elements[element] else { throw ActGuard.Refused(message: "élément [\(element)] inconnu : regarde à nouveau") }
            return p
        }
        guard let x, let y, x >= 0, y >= 0, x <= s.width, y <= s.height else { throw ActGuard.Refused(message: "point hors de la capture") }
        return CGPoint(x: s.frame.minX + CGFloat(x) * s.frame.width / CGFloat(s.width),
                       y: s.frame.minY + CGFloat(y) * s.frame.height / CGFloat(s.height))
    }

    // MARK: accessibility

    private struct AXInfo {
        let role: String
        let subrole: String?
        let label: String
        let secure: Bool
        let center: CGPoint
    }

    private static let actionable: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXTextField",
        "AXTextArea", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXSlider", "AXDisclosureTriangle", "AXIncrementor", "AXCell", "AXRow", "AXTab",
    ]

    private func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }

    private func string(_ el: AXUIElement, _ name: String) -> String? {
        (attr(el, name) as? String).map { $0.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces) }.flatMap { $0.isEmpty ? nil : $0 }
    }

    private func frame(_ el: AXUIElement) -> CGRect? {
        guard let pv = attr(el, kAXPositionAttribute), let sv = attr(el, kAXSizeAttribute),
              CFGetTypeID(pv) == AXValueGetTypeID(), CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero, s = CGSize.zero
        guard AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &s) else { return nil }
        return CGRect(origin: p, size: s)
    }

    private func label(_ el: AXUIElement, role: String) -> String {
        var l = string(el, kAXTitleAttribute) ?? string(el, kAXDescriptionAttribute) ?? ""
        if l.isEmpty, let t = attr(el, kAXTitleUIElementAttribute), CFGetTypeID(t) == AXUIElementGetTypeID() {
            l = string(t as! AXUIElement, kAXValueAttribute) ?? ""
        }
        if l.isEmpty && !role.contains("Text") && role != "AXComboBox" { l = string(el, kAXValueAttribute) ?? "" }
        if l.isEmpty { l = string(el, kAXHelpAttribute) ?? string(el, kAXPlaceholderValueAttribute) ?? "" }
        if l.isEmpty, role == "AXCell" || role == "AXRow" || role == "AXButton" { l = firstText(el, depth: 3) ?? "" }
        return String(l.prefix(120))
    }

    private func firstText(_ el: AXUIElement, depth: Int) -> String? {
        guard depth > 0, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
        for k in kids.prefix(8) {
            if string(k, kAXRoleAttribute) == "AXStaticText", let v = string(k, kAXValueAttribute) { return v }
            if let v = firstText(k, depth: depth - 1) { return v }
        }
        return nil
    }

    private func elements(pid: pid_t, within window: CGRect) -> [AXInfo] {
        let appEl = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appEl, 0.5)
        // Chromium/Electron apps only build their tree when asked to.
        AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        guard let wins = attr(appEl, kAXWindowsAttribute) as? [AXUIElement] else { return [] }
        let root = wins.first { w in frame(w).map { abs($0.minX - window.minX) < 6 && abs($0.minY - window.minY) < 6 } ?? false } ?? wins.first
        guard let root else { return [] }
        var out: [AXInfo] = []
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        var visited = 0
        let deadline = Date().addingTimeInterval(2)
        while !queue.isEmpty, visited < 5000, out.count < 150, Date() < deadline {
            let (el, depth) = queue.removeFirst()
            visited += 1
            let role = string(el, kAXRoleAttribute) ?? ""
            if Self.actionable.contains(role), let f = frame(el), f.width > 2, f.height > 2 {
                let c = CGPoint(x: f.midX, y: f.midY)
                if window.contains(c) {
                    let sub = string(el, kAXSubroleAttribute)
                    let l = label(el, role: role)
                    let isField = role.contains("Text") || role == "AXComboBox"
                    if !l.isEmpty || isField {
                        out.append(AXInfo(role: role, subrole: sub, label: l, secure: ActGuard.isSecure(role: role, subrole: sub, label: l), center: c))
                    }
                    if role != "AXRow" && role != "AXCell" { continue } // a control's children are its own parts
                }
            }
            if depth < 40, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
                for k in kids { queue.append((k, depth + 1)) }
            }
        }
        return out
    }

    /// The element under a screen point, described by its nearest actionable ancestor.
    private func hit(_ p: CGPoint) throws -> (pid: pid_t, role: String, subrole: String?, label: String, secure: Bool) {
        var el: AXUIElement?
        let sys = AXUIElementCreateSystemWide()
        guard AXUIElementCopyElementAtPosition(sys, Float(p.x), Float(p.y), &el) == .success, var cur = el else {
            throw ActGuard.Refused(message: "rien d'accessible à cet endroit")
        }
        var pid: pid_t = 0
        AXUIElementGetPid(cur, &pid)
        var role = string(cur, kAXRoleAttribute) ?? "", sub = string(cur, kAXSubroleAttribute)
        var l = label(cur, role: role)
        var secure = ActGuard.isSecure(role: role, subrole: sub, label: l)
        for _ in 0..<4 where !Self.actionable.contains(role) {
            guard let parent = attr(cur, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
            cur = parent as! AXUIElement
            let r = string(cur, kAXRoleAttribute) ?? ""
            if Self.actionable.contains(r) {
                role = r
                sub = string(cur, kAXSubroleAttribute)
                let pl = label(cur, role: r)
                if !pl.isEmpty { l = pl }
                secure = secure || ActGuard.isSecure(role: r, subrole: sub, label: l)
            }
        }
        return (pid, role, sub, l, secure)
    }

    private func focused(_ pid: pid_t) -> (role: String, subrole: String?, label: String, secure: Bool) {
        let appEl = AXUIElementCreateApplication(pid)
        guard let f = attr(appEl, kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() else {
            return ("", nil, "", false)
        }
        let el = f as! AXUIElement
        let role = string(el, kAXRoleAttribute) ?? "", sub = string(el, kAXSubroleAttribute)
        let l = label(el, role: role)
        return (role, sub, l, ActGuard.isSecure(role: role, subrole: sub, label: l))
    }

    // MARK: probe / act

    func probe(app name: String, element: Int?, x: Int?, y: Int?) throws -> [String: Any] {
        try requireAccessibility()
        let app = try resolve(name)
        try activate(app)
        let target = app.localizedName ?? name
        if element == nil && x == nil {
            let f = focused(app.processIdentifier)
            lastProbe = nil
            return ["app": target, "target": target, "role": f.role.isEmpty ? "none" : f.role, "subrole": f.subrole ?? "", "label": f.label, "secure": f.secure]
        }
        guard let shot = shots[app.processIdentifier] else { throw ActGuard.Refused(message: "regarde d'abord \(target) (screen_look)") }
        let p = try toScreen(element: element, x: x, y: y, shot)
        let h = try hit(p)
        let owner = NSRunningApplication(processIdentifier: h.pid)?.localizedName ?? "?"
        lastProbe = (app.processIdentifier, p, h.label)
        return ["app": owner, "target": target, "role": h.role, "subrole": h.subrole ?? "", "label": h.label, "secure": h.secure]
    }

    func act(_ a: [String: Any], cancel: CancelToken) throws {
        try requireAccessibility()
        guard let name = a["app"] as? String, let action = a["action"] as? String else { throw ActGuard.Refused(message: "action incomplète") }
        let app = try resolve(name)
        try activate(app)
        let pid = app.processIdentifier
        let element = a["element"] as? Int, x = a["x"] as? Int, y = a["y"] as? Int
        var point: CGPoint?
        if element != nil || x != nil {
            guard let shot = shots[pid] else { throw ActGuard.Refused(message: "regarde d'abord \(name) (screen_look)") }
            let p = try toScreen(element: element, x: x, y: y, shot)
            let h = try hit(p)
            guard h.pid == pid else { throw ActGuard.Refused(message: "la cible n'appartient pas à \(name)") }
            if let lp = lastProbe, lp.pid == pid, lp.point == p, lp.label != h.label {
                throw ActGuard.Refused(message: "l'élément a changé depuis la vérification : regarde à nouveau")
            }
            if action == "type" && h.secure { throw ActGuard.Refused(message: "champ de mot de passe : Jarvis n'y tape jamais") }
            point = p
        }
        try cancel.check()
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            throw ActGuard.Refused(message: "\(name) n'est plus au premier plan")
        }
        switch action {
        case "click", "double_click":
            guard let point else { throw ActGuard.Refused(message: "clic sans cible") }
            Input.click(point, count: action == "click" ? 1 : 2)
        case "type":
            guard let text = a["text"] as? String else { throw ActGuard.Refused(message: "texte manquant") }
            if let point {
                Input.click(point, count: 1)
                Thread.sleep(forTimeInterval: 0.15)
            }
            if focused(pid).secure { throw ActGuard.Refused(message: "champ de mot de passe : Jarvis n'y tape jamais") }
            try Input.type(text, cancel: cancel)
        case "key":
            guard let key = a["key"] as? String else { throw ActGuard.Refused(message: "touche manquante") }
            try Input.press(key)
        case "scroll":
            let at = point ?? shots[pid].map { CGPoint(x: $0.frame.midX, y: $0.frame.midY) } ?? NSEvent.mouseLocation
            Input.scroll(at, lines: a["dy"] as? Int ?? 5)
        default:
            throw ActGuard.Refused(message: "action inconnue \(action)")
        }
        lastProbe = nil
    }

    private func blocking<T>(_ work: @escaping () async throws -> T) throws -> T {
        let sem = DispatchSemaphore(value: 0)
        var result: Result<T, Error> = .failure(ActGuard.Refused(message: "capture interrompue"))
        Task.detached {
            do { result = .success(try await work()) } catch { result = .failure(error) }
            sem.signal()
        }
        if sem.wait(timeout: .now() + 15) == .timedOut { throw ActGuard.Refused(message: "capture trop longue") }
        return try result.get()
    }
}

/// Real input events. Characters go through the current keyboard layout (AZERTY ⌘A must not
/// become ⌘Q).
enum Input {
    private static let source = CGEventSource(stateID: .hidSystemState)

    static func click(_ p: CGPoint, count: Int) {
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.03)
        for i in 1...count {
            for type in [CGEventType.leftMouseDown, .leftMouseUp] {
                let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
                e?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
                e?.post(tap: .cghidEventTap)
            }
            Thread.sleep(forTimeInterval: 0.03)
        }
    }

    static func scroll(_ p: CGPoint, lines: Int) {
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: Int32(-lines), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
    }

    static func type(_ text: String, cancel: CancelToken) throws {
        var chunk: [UniChar] = []
        func flush() {
            guard !chunk.isEmpty else { return }
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                e?.post(tap: .cghidEventTap)
            }
            chunk.removeAll()
            Thread.sleep(forTimeInterval: 0.01)
        }
        for ch in text {
            try cancel.check()
            if ch == "\n" || ch == "\r\n" || ch == "\r" {
                flush()
                key(CGKeyCode(kVK_Return), flags: [])
            } else if ch == "\t" {
                flush()
                key(CGKeyCode(kVK_Tab), flags: [])
            } else {
                chunk.append(contentsOf: Array(String(ch).utf16))
                if chunk.count >= 16 { flush() }
            }
        }
        flush()
    }

    private static let named: [String: Int] = [
        "return": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "delete": kVK_Delete, "backspace": kVK_Delete,
        "escape": kVK_Escape, "forwarddelete": kVK_ForwardDelete, "left": kVK_LeftArrow, "right": kVK_RightArrow,
        "up": kVK_UpArrow, "down": kVK_DownArrow, "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp,
        "pagedown": kVK_PageDown, "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
        "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
    ]

    /// Same refusal as the daemon (computer.deny.system_key), kept here too.
    private static let systemKeys: Set<String> = ["cmd+space", "ctrl+space", "cmd+tab", "cmd+shift+tab", "cmd+`", "cmd+option+escape",
                                                  "cmd+shift+q", "cmd+option+shift+q", "cmd+ctrl+q", "cmd+option+d", "cmd+h", "cmd+option+h", "cmd+m"]

    static func press(_ spec: String) throws {
        let parts = spec.lowercased().replacingOccurrences(of: " ", with: "").split(separator: "+").map(String.init)
        guard let last = parts.last else { throw ActGuard.Refused(message: "touche vide") }
        var flags: CGEventFlags = []
        var mods: [String] = []
        for m in parts.dropLast() {
            switch m {
            case "cmd", "command": flags.insert(.maskCommand); mods.append("cmd")
            case "shift": flags.insert(.maskShift); mods.append("shift")
            case "option", "alt": flags.insert(.maskAlternate); mods.append("option")
            case "ctrl", "control": flags.insert(.maskControl); mods.append("ctrl")
            default: throw ActGuard.Refused(message: "modificateur inconnu \(m)")
            }
        }
        let k = last == "enter" ? "return" : last == "esc" ? "escape" : last
        let canonical = (Set(mods).sorted() + [k]).joined(separator: "+")
        if systemKeys.contains(where: { s in
            let p = s.split(separator: "+").map(String.init)
            return (Set(p.dropLast()).sorted() + [p.last ?? ""]).joined(separator: "+") == canonical
        }) {
            throw ActGuard.Refused(message: "\(spec) ferait sortir de l'app : refusé")
        }
        if let code = named[k] {
            key(CGKeyCode(code), flags: flags)
        } else if k.count == 1, let code = layoutCode(for: k) {
            key(code, flags: flags)
        } else {
            throw ActGuard.Refused(message: "touche inconnue \(spec)")
        }
    }

    private static func key(_ code: CGKeyCode, flags: CGEventFlags) {
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
            e?.flags = flags
            e?.post(tap: .cghidEventTap)
        }
        Thread.sleep(forTimeInterval: 0.02)
    }

    /// Key code producing `char` on the current layout (built on the main thread, where TIS lives).
    private static func layoutCode(for char: String) -> CGKeyCode? {
        var map: [String: CGKeyCode] = [:]
        let build = {
            guard let src = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
                  let raw = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else { return }
            let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
            data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
                guard let layout = buf.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
                for code in 0..<128 {
                    var dead: UInt32 = 0
                    var length = 0
                    var chars = [UniChar](repeating: 0, count: 4)
                    let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                                                OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &length, &chars)
                    if status == noErr, length > 0 {
                        let s = String(utf16CodeUnits: chars, count: length).lowercased()
                        if map[s] == nil { map[s] = CGKeyCode(code) }
                    }
                }
            }
        }
        if Thread.isMainThread { build() } else { DispatchQueue.main.sync(execute: build) }
        return map[char]
    }
}
