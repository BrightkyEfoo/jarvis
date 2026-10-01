import Carbon.HIToolbox

/// Global hold-to-talk shortcut. Carbon hot keys need no Accessibility permission and report
/// both press and release, which is exactly push-to-talk.
final class HotKey {
    var onPress: () -> Void = {}
    var onRelease: () -> Void = {}
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?

    init?(keyCode: UInt32, modifiers: UInt32) {
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let me = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return noErr }
            let hotKey = Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue()
            if GetEventKind(event) == UInt32(kEventHotKeyPressed) { hotKey.onPress() } else { hotKey.onRelease() }
            return noErr
        }, 2, &types, me, &handler)
        let id = EventHotKeyID(signature: OSType(0x4A52_5653), id: 1) // 'JRVS'
        let registered = RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &ref)
        if installed != noErr || registered != noErr { return nil }
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
    }
}
