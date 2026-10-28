import Foundation

/// What the page asks of this Mac, iPhone or iPad with `LampNative.call(name, args)` in Web/: the person's own things
/// the page can't reach itself (mail, calendar, reminders, contacts, photos, location…), read with Lamp's building
/// blocks in LampSupport.swift. Each call is registered here once, as the app opens.
enum Native {
    @MainActor static func register() {
        // LampNative.on("events") { args in
        //     try await LampCalendar.events(days: args["days"] as? Int ?? 7).map { ["title": $0.title, "start": $0.start] }
        // }
    }
}
