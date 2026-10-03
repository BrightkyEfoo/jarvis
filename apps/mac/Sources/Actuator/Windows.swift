import AppKit
import ApplicationServices
import ScreenCaptureKit

/// The whole desk: which windows are on which display, a screenshot of a full display, quitting
/// apps the way ⌘Q does, and moving / hiding / arranging windows. Protected apps (shells,
/// settings, credentials, Jarvis) are left out of every list and every capture, and never touched.
extension ScreenActor {
    struct Display {
        let index: Int // 1 = the display with the menu bar
        let id: CGDirectDisplayID
        let bounds: CGRect // global points, top-left origin
    }

    static func displays() -> [Display] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        let main = CGMainDisplayID()
        let shown = ids.prefix(Int(count))
            .filter { CGDisplayMirrorsDisplay($0) == kCGNullDirectDisplay }
            .sorted { a, b in a == main || (b != main && CGDisplayBounds(a).minX < CGDisplayBounds(b).minX) }
        return shown.enumerated().map { Display(index: $0.offset + 1, id: $0.element, bounds: CGDisplayBounds($0.element)) }
    }

    static func display(of frame: CGRect, in displays: [Display]) -> Display? {
        func area(_ r: CGRect) -> CGFloat { r.isNull ? 0 : r.width * r.height }
        return displays.max { area(frame.intersection($0.bounds)) < area(frame.intersection($1.bounds)) }
    }

    /// The display minus menu bar and Dock, in global top-left points.
    static func visibleFrame(_ d: Display) -> CGRect {
        let r: CGRect? = DispatchQueue.main.sync {
            guard let primary = NSScreen.screens.first,
                  let s = NSScreen.screens.first(where: {
                      ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == d.id
                  }) else { return nil }
            let v = s.visibleFrame
            return CGRect(x: v.minX, y: primary.frame.height - v.maxY, width: v.width, height: v.height)
        }
        return r ?? d.bounds
    }

    private struct Seen {
        let app: NSRunningApplication
        let frame: CGRect
        let title: String
        let display: Display?
    }

    /// On-screen windows of Dock apps, front to back.
    private func visibleWindows(_ displays: [Display]) -> [Seen] {
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        let byPid = Dictionary(apps.map { ($0.processIdentifier, $0) }, uniquingKeysWith: { a, _ in a })
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return list.compactMap { w in
            guard let pid = w[kCGWindowOwnerPID as String] as? pid_t, let app = byPid[pid],
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  let b = w[kCGWindowBounds as String] as? NSDictionary, let f = CGRect(dictionaryRepresentation: b),
                  f.width > 60, f.height > 60 else { return nil }
            return Seen(app: app, frame: f, title: w[kCGWindowName as String] as? String ?? "", display: Self.display(of: f, in: displays))
        }
    }

    // MARK: list

    func windows() -> [String: Any] {
        let displays = Self.displays()
        let seen = visibleWindows(displays)
        var perApp: [pid_t: Int] = [:]
        let rows: [[String: Any]] = seen.prefix(200).map { s in
            perApp[s.app.processIdentifier, default: 0] += 1
            let protected = ActGuard.isForbidden(s.app)
            let origin = s.display?.bounds.origin ?? .zero
            var row: [String: Any] = [
                "app": s.app.localizedName ?? "?", "display": s.display?.index ?? 0, "protected": protected,
                "x": Int(s.frame.minX - origin.x), "y": Int(s.frame.minY - origin.y),
                "width": Int(s.frame.width), "height": Int(s.frame.height),
            ]
            if !protected { row["title"] = String(s.title.prefix(200)) }
            return row
        }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let apps: [[String: Any]] = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .prefix(100)
            .map { a in
                ["app": a.localizedName ?? "?", "active": a.processIdentifier == front, "hidden": a.isHidden,
                 "windows": perApp[a.processIdentifier] ?? 0, "protected": ActGuard.isForbidden(a)]
            }
        return [
            "displays": displays.map { ["index": $0.index, "width": Int($0.bounds.width), "height": Int($0.bounds.height)] },
            "windows": rows,
            "apps": apps,
        ]
    }

    // MARK: look at a whole display

    func lookDisplay(_ index: Int, cancel: CancelToken) throws -> [String: Any] {
        try requireCapture()
        let displays = Self.displays()
        guard let d = displays.first(where: { $0.index == index }) else {
            throw ActGuard.Refused(message: "pas d'écran \(index) (il y en a \(displays.count))")
        }
        try cancel.check()
        let image = try blocking { () async throws -> CGImage in
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == d.id }) else {
                throw ActGuard.Refused(message: "écran introuvable pour la capture")
            }
            // Protected apps and money / credential windows are not drawn at all: what is behind them
            // shows instead.
            let hidden = content.windows.filter { w in
                guard let app = w.owningApplication else { return false }
                return ActGuard.isForbidden(bundle: app.bundleIdentifier, name: app.applicationName)
                    || ActGuard.isSensitiveTitle(w.title ?? "")
            }
            let filter = SCContentFilter(display: display, excludingWindows: hidden)
            let scale = CGFloat(filter.pointPixelScale)
            let px = CGSize(width: d.bounds.width * scale, height: d.bounds.height * scale)
            let k = min(1, Self.maxEdge / max(px.width, px.height))
            let cfg = SCStreamConfiguration()
            cfg.width = Int(px.width * k)
            cfg.height = Int(px.height * k)
            cfg.showsCursor = true
            return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        }
        guard let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else {
            throw ActGuard.Refused(message: "encodage JPEG impossible")
        }
        let kx = CGFloat(image.width) / d.bounds.width, ky = CGFloat(image.height) / d.bounds.height
        let rows: [[String: Any]] = visibleWindows(displays)
            .filter { $0.display?.id == d.id && !ActGuard.isForbidden($0.app) && !ActGuard.isSensitiveTitle($0.title) }
            .prefix(60)
            .map { s in
                ["app": s.app.localizedName ?? "?", "title": String(s.title.prefix(200)),
                 "x": Int((s.frame.minX - d.bounds.minX) * kx), "y": Int((s.frame.minY - d.bounds.minY) * ky),
                 "width": Int(s.frame.width * kx), "height": Int(s.frame.height * ky)]
            }
        return ["display": index, "displays": displays.count, "width": image.width, "height": image.height,
                "image": jpeg.base64EncodedString(), "windows": rows]
    }

    // MARK: quit (⌘Q, never force)

    func quit(_ names: [String], cancel: CancelToken) throws -> [String: Any] {
        var targets: [(name: String, app: NSRunningApplication)] = []
        var refused: [String] = [], missing: [String] = []
        for n in names {
            guard let a = Self.running(n) else {
                missing.append(n)
                continue
            }
            let name = a.localizedName ?? n
            if ActGuard.isForbidden(a) || a.bundleIdentifier == "com.apple.finder" {
                refused.append(name)
            } else if !targets.contains(where: { $0.app.processIdentifier == a.processIdentifier }) {
                targets.append((name, a))
            }
        }
        for t in targets { _ = t.app.terminate() }
        func gone(_ a: NSRunningApplication) -> Bool { a.isTerminated || kill(a.processIdentifier, 0) != 0 }
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline, targets.contains(where: { !gone($0.app) }) {
            try cancel.check()
            Thread.sleep(forTimeInterval: 0.1)
        }
        return [
            "quit": targets.filter { gone($0.app) }.map(\.name),
            // Usually an app asking "save changes?": Brightky answers that dialog himself.
            "still_running": targets.filter { !gone($0.app) }.map(\.name),
            "refused": refused,
            "not_running": missing,
        ]
    }

    // MARK: windows

    func manage(_ a: [String: Any], cancel: CancelToken) throws -> [String: Any] {
        guard let name = a["app"] as? String, let action = a["action"] as? String else {
            throw ActGuard.Refused(message: "app et action requises")
        }
        let app = try resolve(name)
        switch action {
        case "front":
            if app.isHidden { app.unhide() }
            try activate(app)
        case "hide":
            app.hide()
        case "show":
            app.unhide()
            try activate(app)
        default:
            try requireAccessibility()
            let win = try mainWindow(app)
            try cancel.check()
            switch action {
            case "minimize":
                try set(win, kAXMinimizedAttribute, kCFBooleanTrue)
            case "restore":
                try set(win, kAXMinimizedAttribute, kCFBooleanFalse)
                try activate(app)
            case "fullscreen":
                let on = (attr(win, "AXFullScreen") as? Bool) ?? false
                try set(win, "AXFullScreen", on ? kCFBooleanFalse : kCFBooleanTrue)
            case "close":
                guard let b = attr(win, kAXCloseButtonAttribute), CFGetTypeID(b) == AXUIElementGetTypeID() else {
                    throw ActGuard.Refused(message: "cette fenêtre n'a pas de bouton fermer")
                }
                AXUIElementPerformAction(b as! AXUIElement, kAXPressAction as CFString)
            case "maximize", "left", "right", "top", "bottom", "center":
                let current = frame(win) ?? .zero
                let displays = Self.displays()
                let target: Display
                if let n = a["display"] as? Int {
                    guard let d = displays.first(where: { $0.index == n }) else {
                        throw ActGuard.Refused(message: "pas d'écran \(n) (il y en a \(displays.count))")
                    }
                    target = d
                } else {
                    guard let d = Self.display(of: current, in: displays) ?? displays.first else {
                        throw ActGuard.Refused(message: "aucun écran")
                    }
                    target = d
                }
                let v = Self.visibleFrame(target)
                let r: CGRect
                switch action {
                case "maximize": r = v
                case "left": r = CGRect(x: v.minX, y: v.minY, width: v.width / 2, height: v.height)
                case "right": r = CGRect(x: v.midX, y: v.minY, width: v.width / 2, height: v.height)
                case "top": r = CGRect(x: v.minX, y: v.minY, width: v.width, height: v.height / 2)
                case "bottom": r = CGRect(x: v.minX, y: v.midY, width: v.width, height: v.height / 2)
                default:
                    let w = min(current.width, v.width), h = min(current.height, v.height)
                    r = CGRect(x: v.midX - w / 2, y: v.midY - h / 2, width: w, height: h)
                }
                try place(win, r)
            default:
                throw ActGuard.Refused(message: "action de fenêtre inconnue \(action)")
            }
        }
        return ["app": app.localizedName ?? name]
    }

    private func mainWindow(_ app: NSRunningApplication) throws -> AXUIElement {
        let el = AXUIElementCreateApplication(app.processIdentifier)
        for key in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            if let w = attr(el, key), CFGetTypeID(w) == AXUIElementGetTypeID() { return w as! AXUIElement }
        }
        if let all = attr(el, kAXWindowsAttribute) as? [AXUIElement], let w = all.first { return w }
        throw ActGuard.Refused(message: "\(app.localizedName ?? "l'app") n'a pas de fenêtre")
    }

    private func set(_ el: AXUIElement, _ name: String, _ value: CFTypeRef) throws {
        let e = AXUIElementSetAttributeValue(el, name as CFString, value)
        if e != .success { throw ActGuard.Refused(message: "macOS a refusé la modification de la fenêtre (\(e.rawValue))") }
    }

    private func place(_ win: AXUIElement, _ r: CGRect) throws {
        var p = r.origin, s = r.size
        guard let pv = AXValueCreate(.cgPoint, &p), let sv = AXValueCreate(.cgSize, &s) else {
            throw ActGuard.Refused(message: "géométrie invalide")
        }
        try set(win, kAXPositionAttribute, pv)
        try set(win, kAXSizeAttribute, sv)
        // Moving to another display, the size can clamp the position: set it again.
        _ = AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, pv)
    }
}
