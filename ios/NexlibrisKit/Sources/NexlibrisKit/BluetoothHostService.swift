import CoreBluetooth
import Foundation

/**
 * The app as a sync hub over Bluetooth LE (common/src/bluetoothApi.ts): a GATT server that
 * browsers and the desktop app connect to with Web Bluetooth, as Android's
 * `BluetoothHostService.kt`. It only carries bytes: requests are put back together from their
 * chunks ([BluetoothFraming]) and handed to the page as events ([next]), and the page's responses
 * are sent back in chunks that fit each device's link ([send]). Pairing, keys and the library are
 * the page's (common/src/syncHub.ts).
 *
 * CoreBluetooth asks for permission itself, the first time hosting starts, and has no events for
 * connecting: a device counts as connected once it subscribes to the responses (Web Bluetooth does
 * before it writes), and as gone when it unsubscribes. Hosting stops while the app is in the
 * background, as iOS stops advertising then.
 */
public final class BluetoothHostService: NSObject, CBPeripheralManagerDelegate {
    public static let service = CBUUID(string: "4e28ef00-8886-467b-9c6a-a0b49a90cf89")
    public static let requests = CBUUID(string: "75b3ab92-7677-4775-96eb-6df34e2ea9fe")
    public static let responses = CBUUID(string: "9a47303a-9028-4737-af10-810a6f50a363")
    /// What nearby devices see it as, in a browser's device chooser.
    static let advertisedName = "nexlibris"
    private static let enabledKey = "bluetoothHosting"
    private static let maxWait: TimeInterval = 30
    private static let sendTimeout: TimeInterval = 10

    /// One connected device: its link's size, and its request in progress.
    private final class Link {
        let central: CBCentral
        let assembler = BluetoothFraming.Assembler()
        init(_ central: CBCentral) { self.central = central }
    }

    private let defaults: UserDefaults
    /// CoreBluetooth's calls, and every use of [manager], are on this queue.
    private let queue = DispatchQueue(label: "org.nexlibris.bluetooth")
    private var manager: CBPeripheralManager?
    private var characteristic: CBMutableCharacteristic?
    private let events = BlockingQueue<JSONObject>()
    private var links: [String: Link] = [:]
    private var added = false
    private var advertising = false
    private var error: String?
    /// Waiting for the manager's state, once it's created.
    private var stateKnown: Waiter<CBManagerState>?
    /// Signalled when the manager has room to send again.
    private let ready = DispatchSemaphore(value: 0)

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    private var enabled: Bool { defaults.bool(forKey: Self.enabledKey) }

    public func status() -> JSONObject {
        queue.sync {
            var status: JSONObject = ["enabled": enabled, "running": added && advertising, "connected": links.count]
            if advertising { status["name"] = Self.advertisedName }
            if let error { status["error"] = error }
            return status
        }
    }

    public func setEnabled(_ on: Bool) -> JSONObject {
        defaults.set(on, forKey: Self.enabledKey)
        if on { start() } else { stop() }
        return status()
    }

    /// Waits up to [timeoutMs] for events; returns those there are.
    public func next(timeoutMs: Int64) -> [JSONObject] {
        let wait = min(max(Double(timeoutMs) / 1000, 0), Self.maxWait)
        guard let first = events.poll(timeout: wait) else { return [] }
        var list = [first]
        while let more = events.poll() { list.append(more) }
        return list
    }

    /// Sends a whole message to [device], a chunk at a time, waiting whenever the system's queue is full.
    public func send(device: String, data: String) throws {
        let message = try decodeBase64(data)
        let (link, characteristic, manager) = queue.sync { (links[device], self.characteristic, self.manager) }
        guard let link else { throw NexlibrisError("That device has disconnected.") }
        guard let characteristic, let manager else { throw NexlibrisError("Bluetooth hosting is off.") }
        for chunk in try BluetoothFraming.chunks(message, size: link.central.maximumUpdateValueLength) {
            while !queue.sync(execute: { manager.updateValue(chunk, for: characteristic, onSubscribedCentrals: [link.central]) }) {
                if ready.wait(timeout: .now() + Self.sendTimeout) == .timedOut { throw NexlibrisError("That device stopped answering.") }
                if queue.sync(execute: { links[device] == nil }) { throw NexlibrisError("That device has disconnected.") }
            }
        }
    }

    /// Starts hosting, if it isn't already, asking for Bluetooth the first time. Called again when the app opens, if it was left on.
    private func start() {
        let known: Waiter<CBManagerState>? = queue.sync {
            error = nil
            if manager != nil { return nil }
            let waiter = Waiter<CBManagerState>()
            stateKnown = waiter
            manager = CBPeripheralManager(delegate: self, queue: queue, options: [CBPeripheralManagerOptionShowPowerAlertKey: true])
            return waiter
        }
        // The first time, the system asks the user, so this can take a while.
        if let known, known.wait(timeout: .now() + 120) == nil {
            queue.sync { fail("Bluetooth didn’t start. Try again.") }
        }
    }

    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn:
            if !added && characteristic == nil { addService(peripheral) }
        case .unauthorized:
            fail("nexlibris wasn’t allowed to use Bluetooth. Allow it in Settings › nexlibris.")
        case .unsupported:
            fail("This device can’t host over Bluetooth LE.")
        case .poweredOff:
            fail("Bluetooth is off. Turn it on to host sync.")
        case .resetting, .unknown:
            return
        @unknown default:
            return
        }
        stateKnown?.finish(peripheral.state)
        stateKnown = nil
    }

    private func addService(_ peripheral: CBPeripheralManager) {
        let responses = CBMutableCharacteristic(type: Self.responses, properties: [.notify], value: nil, permissions: [.readable])
        let requests = CBMutableCharacteristic(type: Self.requests, properties: [.write], value: nil, permissions: [.writeable])
        let service = CBMutableService(type: Self.service, primary: true)
        service.characteristics = [requests, responses]
        characteristic = responses
        // Advertised once the service is in place (didAdd), so no one connects to an empty server.
        peripheral.add(service)
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error { return fail("Couldn’t start Bluetooth hosting (\(error.localizedDescription)).") }
        added = true
        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [Self.service],
            CBAdvertisementDataLocalNameKey: Self.advertisedName,
        ])
    }

    public func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error {
            advertising = false
            self.error = "Couldn’t advertise over Bluetooth (\(error.localizedDescription))."
        } else {
            advertising = true
            self.error = nil
        }
    }

    /// Stops hosting with [message] as the reason; called on [queue].
    private func fail(_ message: String) {
        teardown()
        error = message
    }

    public func stop() {
        queue.sync {
            teardown()
            error = nil
        }
    }

    private func teardown() {
        manager?.stopAdvertising()
        manager?.removeAllServices()
        manager?.delegate = nil
        manager = nil
        characteristic = nil
        added = false
        advertising = false
        for id in links.keys { events.put(["kind": "disconnected", "device": id]) }
        links.removeAll()
        stateKnown?.finish(.unknown)
        stateKnown = nil
    }

    /// Resumes hosting when the app opens, if it was left on.
    public func resume() {
        if enabled { DispatchQueue.global().async { self.start() } }
    }

    private func link(_ central: CBCentral) -> Link {
        let id = central.identifier.uuidString
        if let link = links[id] { return link }
        let link = Link(central)
        links[id] = link
        events.put(["kind": "connected", "device": id])
        return link
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        _ = link(central)
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        let id = central.identifier.uuidString
        if links.removeValue(forKey: id) != nil { events.put(["kind": "disconnected", "device": id]) }
        ready.signal()
    }

    public func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        ready.signal()
    }

    /// A write, or a long write's parts (by offset), which together are one chunk.
    public func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        guard requests.allSatisfy({ $0.characteristic.uuid == Self.requests && $0.central.identifier == first.central.identifier }) else {
            return peripheral.respond(to: first, withResult: .writeNotPermitted)
        }
        var chunk = Data()
        for request in requests.sorted(by: { $0.offset < $1.offset }) {
            if request.offset != chunk.count { return peripheral.respond(to: first, withResult: .invalidOffset) }
            chunk.append(request.value ?? Data())
        }
        peripheral.respond(to: first, withResult: .success)
        let link = link(first.central)
        if let message = link.assembler.push(chunk) {
            events.put(["kind": "message", "device": first.central.identifier.uuidString, "data": message.base64EncodedString()])
        }
    }
}
