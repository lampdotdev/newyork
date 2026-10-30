// Lamp's game kit: the app around a game drawn with three.js, on the Mac, the iPhone and the iPad. Lamp writes this
// file before every build; the game itself is the page in Web/, which this shows in a web view of its own.
//
// On the Mac it's one window with the game filling it, under a title bar with nothing in it, so Lamp's wand floats at
// its top right and the chat opens beside it like any app's. On an iPhone or iPad it's the whole screen, on its side.
// The page is served and shown by Lamp's common host for a page (LampPage.swift), at the game's own address
// (lamp-game://app/); what it logs goes to the app's log, and its sound plays without a tap first.
import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@main
struct LampGameApp: SwiftUI.App {
    var body: some SwiftUI.Scene {
        WindowGroup("New York") {
            LampGameScreen()
        }
        #if os(macOS)
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1280, height: 720)
        .commands { LampCommands() }
        #endif
    }
}

struct LampGameScreen: View {
    // How to play is the game's own to show, named for what the player holds (label() and glyph() in lamp-game.js), so
    // nothing here lists keys that may not be the game's or the player's.
    var body: some View {
        ZStack {
            Color.black
            LampGameSurface()
        }
        .ignoresSafeArea()
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 270)
        #else
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        #endif
    }
}

/// The page that is the game, served by Lamp's common host (LampPage.swift): it logs its own errors, and takes Lamp's
/// changes while it's open (`LampPageLive`).
@MainActor enum LampGamePage {
    static let files = LampPageFiles(scheme: "lamp-game")

    static func make() -> WKWebView { LampPageView.make(files, catchErrors: false, live: true) }
}

#if os(macOS)
struct LampGameSurface: NSViewRepresentable {
    func makeNSView(context: Context) -> LampKeyCatcher { LampKeyCatcher(holding: LampGamePage.make()) }
    func updateNSView(_ view: LampKeyCatcher, context: Context) {
        DispatchQueue.main.async { view.window?.makeFirstResponder(view.page) }
    }
}

/// Holds the page and takes the keys it hands back. WebKit gives back every key the page doesn't cancel, and a game
/// reads its keys without cancelling most of them, so each would reach the window, which beeps for a key nothing took.
/// A shortcut with ⌘ goes to the menus first: the web view says it took every one, before the page has even seen it,
/// so macOS looks no further and ⌘Q, ⌘W and ⌘H would do nothing while the game has the keyboard.
final class LampKeyCatcher: NSView {
    let page: WKWebView

    init(holding page: WKWebView) {
        self.page = page
        super.init(frame: .zero)
        page.frame = bounds
        page.autoresizingMask = [.width, .height]
        addSubview(page)
    }

    required init?(coder: NSCoder) { nil }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command), NSApp.mainMenu?.performKeyEquivalent(with: event) == true { return true }
        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {}
    override func keyUp(with event: NSEvent) {}
    override func doCommand(by selector: Selector) {}
}
#else
struct LampGameSurface: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { LampGamePage.make() }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#endif
