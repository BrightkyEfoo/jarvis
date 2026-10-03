import AppKit
import SwiftUI

/// "Screenshots of text" for posts: a quote or a code snippet set as a 1080 × 1350 card (LinkedIn's
/// portrait format), signed. Rendered natively by SwiftUI: no browser, no download.
struct PostCard: View {
    let kind: String
    let title: String?
    let text: String
    let footer: String

    private var lines: Int { text.split(separator: "\n", omittingEmptySubsequences: false).count }
    private var longest: Int { text.split(separator: "\n").map(\.count).max() ?? 1 }
    /// As large as the number of lines allows, but code never wraps (SF Mono ≈ 0.6 em per character, with a margin).
    private var codeSize: CGFloat { max(16, min(42, 48 - CGFloat(lines) * 1.2, 800 / (0.66 * CGFloat(max(longest, 1))))) }
    private var quoteSize: CGFloat { max(38, min(72, 80 - CGFloat(text.count) / 8)) }
    private let accent = Color(red: 0.38, green: 0.65, blue: 1.0)

    var body: some View {
        VStack(alignment: .leading, spacing: 36) {
            if let title, !title.isEmpty {
                Text(title).font(.system(size: 56, weight: .bold)).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
                Capsule().fill(accent).frame(width: 96, height: 8)
            }
            Spacer(minLength: 0)
            if kind == "code" {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(spacing: 12) {
                        ForEach([Color.red, .yellow, .green], id: \.self) { Circle().fill($0.opacity(0.85)).frame(width: 18, height: 18) }
                    }
                    Text(text)
                        .font(.system(size: codeSize, design: .monospaced))
                        .foregroundStyle(Color(white: 0.92))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(40)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 28).fill(Color(red: 0.08, green: 0.09, blue: 0.12)))
                .overlay(RoundedRectangle(cornerRadius: 28).stroke(Color.white.opacity(0.08), lineWidth: 2))
            } else {
                Text("“").font(.system(size: 180, weight: .bold, design: .serif)).foregroundStyle(accent).frame(height: 110, alignment: .top)
                Text(text)
                    .font(.system(size: quoteSize, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineSpacing(10)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            HStack {
                Text(footer).font(.system(size: 30, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
                Spacer()
                Text("brightkyefoo.cm").font(.system(size: 26)).foregroundStyle(.white.opacity(0.55))
            }
        }
        .padding(80)
        .frame(width: 1080, height: 1350, alignment: .topLeading)
        .background(
            LinearGradient(
                colors: [Color(red: 0.04, green: 0.06, blue: 0.11), Color(red: 0.09, green: 0.13, blue: 0.24)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
        )
        .environment(\.colorScheme, .dark)
    }
}

enum CardRenderer {
    @MainActor
    static func png(_ a: [String: Any]) throws -> [String: Any] {
        let text = String((a["text"] as? String ?? "").prefix(2000))
        guard !text.isEmpty else { throw ActGuard.Refused(message: "carte vide") }
        let card = PostCard(
            kind: a["style"] as? String == "code" ? "code" : "quote",
            title: (a["title"] as? String).map { String($0.prefix(120)) },
            text: text,
            footer: String((a["footer"] as? String ?? "Brightky Efo'o").prefix(60))
        )
        let renderer = ImageRenderer(content: card)
        renderer.scale = 1
        guard let image = renderer.cgImage,
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw ActGuard.Refused(message: "rendu de la carte impossible")
        }
        return ["image": png.base64EncodedString(), "width": image.width, "height": image.height]
    }
}
