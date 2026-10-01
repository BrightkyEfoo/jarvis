import AppKit

/// Defence in depth. jarvisd decides (sealed policy, audit); the app refuses on its own the few
/// things that must never happen even if the daemon were wrong or impersonated.
enum ActGuard {
    struct Refused: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private static let forbiddenBundles: Set<String> = [
        "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty",
        "net.kovidgoyal.kitty", "org.alacritty", "co.zeit.hyper", "com.github.wez.wezterm",
        "com.apple.systempreferences", "com.apple.Settings", "com.apple.keychainaccess", "com.apple.Passwords",
        "com.apple.ScriptEditor2", "com.apple.Automator", "com.apple.installer", "com.apple.DiskUtility",
        "com.apple.ActivityMonitor", "com.apple.Console", "com.apple.MigrateAssistant",
        "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.LastPass",
        "com.dashlane.dashlanephonefinal", "org.keepassxc.keepassxc",
        "cm.brightkyefoo.jarvis",
    ]
    private static let forbiddenNames: Set<String> = [
        "terminal", "iterm", "iterm2", "warp", "ghostty", "kitty", "alacritty", "hyper", "wezterm",
        "system settings", "system preferences", "réglages système", "keychain access", "trousseau d’accès",
        "trousseau d'accès", "passwords", "mots de passe", "script editor", "éditeur de script", "automator",
        "installer", "programme d’installation", "disk utility", "utilitaire de disque", "activity monitor",
        "moniteur d’activité", "console", "1password", "bitwarden", "lastpass", "dashlane", "keepassxc", "jarvis",
    ]

    static func check(app: NSRunningApplication) throws {
        let name = (app.localizedName ?? "").lowercased()
        if let id = app.bundleIdentifier, forbiddenBundles.contains(id) { throw Refused(message: "\(app.localizedName ?? id) n'est jamais piloté") }
        if forbiddenNames.contains(name) { throw Refused(message: "\(app.localizedName ?? name) n'est jamais piloté") }
    }

    private static let forbiddenHosts = ["paypal.com", "stripe.com", "wise.com", "revolut.com", "1password.com", "lastpass.com",
                                         "bitwarden.com", "accounts.google.com", "myaccount.google.com", "passwords.google.com",
                                         "pay.google.com", "appleid.apple.com", "account.apple.com", "orangemoney.cm"]

    static func check(url: String) throws {
        guard let u = URL(string: url), let host = u.host?.lowercased() else { return }
        if host.contains("bank") || host.contains("banque") { throw Refused(message: "site bancaire : hors périmètre") }
        if forbiddenHosts.contains(where: { host == $0 || host.hasSuffix("." + $0) }) { throw Refused(message: "\(host) : site interdit") }
        let path = u.path.lowercased()
        if host == "github.com" && path.hasPrefix("/settings") { throw Refused(message: "réglages du compte GitHub : interdit") }
    }

    /// Password / code fields, by AX subrole or description.
    static func isSecure(role: String, subrole: String?, label: String) -> Bool {
        if subrole == "AXSecureTextField" { return true }
        let l = label.lowercased()
        return role.contains("TextField") && (l.contains("password") || l.contains("mot de passe") || l.contains("passcode"))
    }
}
