package org.nexlibris.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.CompletableFuture

/**
 * Hosts the web app in a WebView. The app is served from assets at
 * https://appassets.androidplatform.net (a real https origin, so modules,
 * workers and storage behave as in a browser), and its library is stored in the
 * app's files through [NativeBridge] rather than in the WebView's OPFS.
 */
class MainActivity : ComponentActivity() {
    private lateinit var webView: WebView
    private lateinit var bridge: NativeBridge

    private var pendingFiles: ValueCallback<Array<Uri>>? = null
    private val pickFiles = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        deliverFiles(uris)
    }
    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        deliverFiles(listOfNotNull(uri))
    }

    /** The page's camera request waiting on the system's permission dialog, if any. */
    private var pendingCamera: PermissionRequest? = null
    private val requestCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        pendingCamera?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else it.deny() }
        pendingCamera = null
    }

    /** The import picker the bridge is waiting on, if any. */
    @Volatile
    private var pendingImport: CompletableFuture<List<Uri>>? = null
    private val pickForImport = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        pendingImport?.complete(uris)
        pendingImport = null
    }

    /** The folder picker for importing the bridge is waiting on, if any. */
    @Volatile
    private var pendingImportFolder: CompletableFuture<Uri?>? = null
    private val pickFolderForImport = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        pendingImportFolder?.complete(uri)
        pendingImportFolder = null
    }

    /** Bluetooth permissions, and turning Bluetooth on, that hosting sync is waiting on, if any. */
    @Volatile
    private var pendingBluetoothPermissions: CompletableFuture<Map<String, Boolean>>? = null
    private val requestBluetoothPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        pendingBluetoothPermissions?.complete(it)
        pendingBluetoothPermissions = null
    }

    @Volatile
    private var pendingBluetoothOn: CompletableFuture<Boolean>? = null
    private val turnOnBluetooth = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        pendingBluetoothOn?.complete(it.resultCode == Activity.RESULT_OK)
        pendingBluetoothOn = null
    }

    private lateinit var bluetoothHost: BluetoothHostService

    /** The folder picker for the sync folder the bridge is waiting on, if any. */
    @Volatile
    private var pendingFolder: CompletableFuture<Uri?>? = null
    private val pickFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        pendingFolder?.complete(uri)
        pendingFolder = null
    }

    /** The "Save as" picker the bridge is waiting on, if any. */
    @Volatile
    private var pendingSave: CompletableFuture<Uri?>? = null
    private val createDocument = registerForActivityResult(CreateDocumentAs()) { uri ->
        pendingSave?.complete(uri)
        pendingSave = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        webView = WebView(this)
        // A WebView ignores its own padding, so the system bars are kept clear by padding a container.
        val container = FrameLayout(this).apply { addView(webView) }
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
        }

        val storage = StorageService(File(filesDir, "libraries/default"))
        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(APP_HOST)
            // Before "/", which would answer for these paths too.
            .addPathHandler("/library/", LibraryFilesPathHandler(storage))
            .addPathHandler("/", WebAppPathHandler(assets))
            .build()

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (isAppUrl(request.url)) return false
                // Links out of the app (e.g. in book descriptions) open in the browser.
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (_: ActivityNotFoundException) {
                }
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                pendingFiles?.onReceiveValue(null)
                pendingFiles = callback
                // The page's accept list is file extensions, which don't map reliably to MIME types.
                val types = arrayOf("*/*")
                if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) pickFiles.launch(types) else pickFile.launch(types)
                return true
            }

            // The camera, for scanning ISBN barcodes. Only the app's own pages get it, and nothing else is granted.
            override fun onPermissionRequest(request: PermissionRequest) {
                if (!isAppUrl(request.origin) || !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                    request.deny()
                    return
                }
                val camera = arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
                ) {
                    request.grant(camera)
                } else {
                    pendingCamera?.deny()
                    pendingCamera = request
                    requestCamera.launch(Manifest.permission.CAMERA)
                }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingCamera == request) pendingCamera = null
            }
        }

        val saves = SaveService(File(cacheDir, "saves"), ::chooseSaveDestination)
        val imports = ImportService(storage, ::chooseImportSources)
        bluetoothHost = BluetoothHostService(this, getSharedPreferences("sync", MODE_PRIVATE), ::prepareBluetooth)
        val syncFolders = SyncFolderService(contentResolver, getSharedPreferences("sync", MODE_PRIVATE), ::chooseSyncFolder)
        bridge = NativeBridge(
            RpcRouter(
                storageRoutes(storage),
                saveRoutes(saves),
                importRoutes(imports),
                peerRoutes(PeerService(storage)),
                bluetoothHostRoutes(bluetoothHost),
                usbFolderRoutes(syncFolders::folder, storage, syncFolders::info, syncFolders::choose),
            ),
        )
        bluetoothHost.resume()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "NexlibrisAndroid", setOf("https://$APP_HOST"), bridge)
        } else {
            // A WebView too old for this keeps the library in its own storage (OPFS) instead.
            Log.w("MainActivity", "WebView has no WEB_MESSAGE_LISTENER; the library stays in the WebView")
        }

        onBackPressedDispatcher.addCallback(this) {
            if (webView.canGoBack()) {
                webView.goBack()
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        }

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl("https://$APP_HOST/")
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        pendingSave?.complete(null)
        pendingImport?.complete(emptyList())
        pendingFolder?.complete(null)
        pendingBluetoothPermissions?.complete(emptyMap())
        pendingBluetoothOn?.complete(false)
        bluetoothHost.stop()
        bridge.shutdown()
        webView.destroy()
        super.onDestroy()
    }

    /** Shows the "Save as" picker and waits for it; called on the bridge's thread, never the main one. */
    private fun chooseSaveDestination(name: String, mimeType: String): OutputStream? {
        val choice = CompletableFuture<Uri?>()
        runOnUiThread {
            pendingSave?.complete(null)
            pendingSave = choice
            createDocument.launch(name to mimeType)
        }
        val uri = choice.get() ?: return null
        return contentResolver.openOutputStream(uri) ?: throw IOException("Couldn't open $uri")
    }

    /**
     * Makes Bluetooth usable for hosting sync: asks for the "Nearby devices" permissions (Android 12
     * on), then to turn Bluetooth on. Throws with what to do if either is refused. Called on the
     * bridge's thread, as it waits on the user.
     */
    @SuppressLint("MissingPermission")
    private fun prepareBluetooth() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val needed = arrayOf(Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
            if (needed.any { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }) {
                val choice = CompletableFuture<Map<String, Boolean>>()
                runOnUiThread {
                    pendingBluetoothPermissions?.complete(emptyMap())
                    pendingBluetoothPermissions = choice
                    requestBluetoothPermissions.launch(needed)
                }
                val granted = choice.get()
                if (needed.any { granted[it] != true }) {
                    throw IllegalStateException("nexlibris wasn’t allowed to use Bluetooth. Allow “Nearby devices” in its app settings.")
                }
            }
        }
        val adapter = getSystemService(BluetoothManager::class.java)?.adapter ?: throw IllegalStateException("This device has no Bluetooth.")
        if (!adapter.isEnabled) {
            val choice = CompletableFuture<Boolean>()
            runOnUiThread {
                pendingBluetoothOn?.complete(false)
                pendingBluetoothOn = choice
                turnOnBluetooth.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
            }
            if (!choice.get()) throw IllegalStateException("Bluetooth is off. Turn it on to host sync.")
        }
    }

    /** Shows the folder picker for the sync folder and waits for it; called on the bridge's thread. */
    private fun chooseSyncFolder(): Uri? {
        val choice = CompletableFuture<Uri?>()
        runOnUiThread {
            pendingFolder?.complete(null)
            pendingFolder = choice
            pickFolder.launch(null)
        }
        return choice.get()
    }

    /** Shows the system picker for files, or a folder, to import and waits for it; called on the bridge's thread. */
    private fun chooseImportSources(folder: Boolean): List<PickedSource> {
        if (folder) {
            val choice = CompletableFuture<Uri?>()
            runOnUiThread {
                pendingImportFolder?.complete(null)
                pendingImportFolder = choice
                pickFolderForImport.launch(null)
            }
            val tree = choice.get() ?: return emptyList()
            return documentTreeFiles(contentResolver, tree)
        }
        val choice = CompletableFuture<List<Uri>>()
        runOnUiThread {
            pendingImport?.complete(emptyList())
            pendingImport = choice
            // Types are left open: the page's formats are file extensions, which ImportService checks.
            pickForImport.launch(arrayOf("*/*"))
        }
        return choice.get().map { uri ->
            val (name, size) = nameAndSize(uri)
            PickedSource(name, size = size) {
                contentResolver.openInputStream(uri) ?: throw IOException("Couldn't open $uri")
            }
        }
    }

    /** A picked document's name, and its size (0 if the provider doesn't say). */
    private fun nameAndSize(uri: Uri): Pair<String, Long> {
        val found = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) to (if (cursor.isNull(1)) 0L else cursor.getLong(1)) else null
        }
        return (found?.first ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file") to (found?.second ?: 0L)
    }

    private fun deliverFiles(uris: List<Uri>) {
        pendingFiles?.onReceiveValue(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
        pendingFiles = null
    }

    private fun isAppUrl(uri: Uri) = uri.scheme == "https" && uri.host == APP_HOST

    private companion object {
        const val APP_HOST = WebViewAssetLoader.DEFAULT_DOMAIN
    }
}

/** ACTION_CREATE_DOCUMENT with the type and suggested name chosen per call: (name, mimeType) to the chosen location. */
private class CreateDocumentAs : ActivityResultContract<Pair<String, String>, Uri?>() {
    override fun createIntent(context: Context, input: Pair<String, String>): Intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(input.second)
            .putExtra(Intent.EXTRA_TITLE, input.first)

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
        intent?.data.takeIf { resultCode == Activity.RESULT_OK }
}
