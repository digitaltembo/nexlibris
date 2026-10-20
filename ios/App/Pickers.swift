import UIKit
import UniformTypeIdentifiers

/**
 * The system's document pickers, shown for the bridge's queues, which wait for the user's choice
 * (as Android's activity results are waited on). Each call blocks, so it must never be made on the
 * main thread; a picker still open when another is asked for is cancelled.
 */
final class Pickers: NSObject, UIDocumentPickerDelegate {
    private weak var controller: UIViewController?
    /// The picker the bridge is waiting on, if any; only touched on the main thread.
    private var pending: (([URL]) -> Void)?

    init(_ controller: UIViewController) {
        self.controller = controller
    }

    /// Files to import, any type (the page's formats are file extensions, which ImportService checks), each in its security scope.
    func files() -> [URL] {
        present {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: false)
            picker.allowsMultipleSelection = true
            return picker
        }
    }

    /// A folder, starting at [initial] if given; nil if none was chosen.
    func folder(startingAt initial: URL? = nil) -> URL? {
        present {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.directoryURL = initial
            return picker
        }.first
    }

    /// Offers [file] to save wherever the user chooses; true if they did.
    func export(_ file: URL) -> Bool {
        !present { UIDocumentPickerViewController(forExporting: [file], asCopy: true) }.isEmpty
    }

    private func present(_ make: @escaping () -> UIDocumentPickerViewController) -> [URL] {
        precondition(!Thread.isMainThread, "Pickers wait for the user, so they're shown from the bridge's queues")
        let done = DispatchSemaphore(value: 0)
        var chosen: [URL] = []
        DispatchQueue.main.async { [self] in
            pending?([])
            guard var top = controller else {
                done.signal()
                return
            }
            while let shown = top.presentedViewController, !shown.isBeingDismissed { top = shown }
            let picker = make()
            picker.delegate = self
            pending = { urls in
                chosen = urls
                done.signal()
            }
            top.present(picker, animated: true)
        }
        done.wait()
        return chosen
    }

    private func finish(_ urls: [URL]) {
        let callback = pending
        pending = nil
        callback?(urls)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(urls) }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish([]) }
}
