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

    /// Never looked at, driven, quit or captured: shells, settings, credentials, Jarvis itself.
    static func isForbidden(bundle: String?, name: String?) -> Bool {
        if let bundle, forbiddenBundles.contains(bundle) { return true }
        return forbiddenNames.contains((name ?? "").lowercased())
    }

    static func isForbidden(_ app: NSRunningApplication) -> Bool {
        isForbidden(bundle: app.bundleIdentifier, name: app.localizedName)
    }

    static func check(app: NSRunningApplication) throws {
        if isForbidden(app) { throw Refused(message: "\(app.localizedName ?? app.bundleIdentifier ?? "cette app") n'est jamais piloté") }
    }

    private static let forbiddenHosts = ["paypal.com", "stripe.com", "wise.com", "revolut.com", "1password.com", "lastpass.com",
                                         "bitwarden.com", "accounts.google.com", "myaccount.google.com", "passwords.google.com",
                                         "pay.google.com", "appleid.apple.com", "account.apple.com", "orangemoney.cm",
                                         "linkedin.com"]

    static func check(url: String) throws {
        guard let u = URL(string: url), let host = u.host?.lowercased() else { return }
        if host.contains("bank") || host.contains("banque") { throw Refused(message: "site bancaire : hors périmètre") }
        if forbiddenHosts.contains(where: { host == $0 || host.hasSuffix("." + $0) }) { throw Refused(message: "\(host) : site interdit") }
        let path = u.path.lowercased()
        if host == "github.com" && path.hasPrefix("/settings") { throw Refused(message: "réglages du compte GitHub : interdit") }
    }

    /// A window whose title shows money or credentials (a bank tab in the browser, a wallet…): never
    /// captured, even inside a whole-screen picture.
    static func isSensitiveTitle(_ title: String) -> Bool {
        let t = title.lowercased()
        if t.isEmpty { return false }
        let words = ["bank", "banque", "banking", "afriland", "ecobank", "société générale", "sgbc", "bicec", "uba ",
                     "paypal", "stripe", "revolut", "orange money", "mobile money", "momo", "mtn money",
                     "wallet", "portefeuille", "coinbase", "binance", "1password", "bitwarden", "lastpass", "dashlane",
                     "keychain", "trousseau", "mots de passe", "passwords", "relevé de compte", "solde"]
        return words.contains { t.contains($0) }
    }

    /// Password / code fields, by AX subrole or description.
    static func isSecure(role: String, subrole: String?, label: String) -> Bool {
        if subrole == "AXSecureTextField" { return true }
        let l = label.lowercased()
        return role.contains("TextField") && (l.contains("password") || l.contains("mot de passe") || l.contains("passcode"))
    }
}
