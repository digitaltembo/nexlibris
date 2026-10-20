package org.nexlibris.app

import org.json.JSONObject
import java.io.IOException

/**
 * The folders the user picks for the library ([LibraryFolderService]), by id: on the phone, a
 * folder picked with the system's folder picker (its tree URI), which the app keeps a lasting
 * permission for, and no other; in tests, plain folders.
 */
interface Folders {
    /** Shows the picker and waits; the folder's id, or null if none was chosen. */
    fun pick(): String?
    /** The folder as storage, from [base] in it. */
    fun open(id: String, base: String = ""): LibraryTree
    /** Where it is, as the user knows it, e.g. "Documents/Books". */
    fun where(id: String): String
    /** Whether the app may still use it (the user can take the permission back, or delete the folder). */
    fun mayUse(id: String): Boolean
    /** Keeps the permission to use it, across restarts. */
    fun keep(id: String)
    /** Lets go of every folder's permission but these. */
    fun releaseAllBut(ids: Set<String>)
    /** Whether one folder is the other or inside it, either way round. */
    fun overlap(a: String, b: String): Boolean
}

/**
 * Where Android keeps the library (common/src/libraryFolderApi.ts, as the desktop app serves it):
 * the app's own storage ([home], the default, which only nexlibris can see and which goes when it's
 * uninstalled), or a folder of the user's in shared storage, with the books laid out in it
 * (common/src/placedLibrary.ts) and nexlibris's own files in `.nexlibris/`. The page reads and
 * writes [root]; imports and files from a hub go into [data]. Moving the library copies it (the
 * two are on different storage, and a folder of the user's is only reached through the storage
 * provider), checks each copy, and deletes the originals once everything has copied; if anything
 * fails, the copies are deleted and the library stays where it was.
 *
 * [chosen] reads and writes which folder the library is in (null for [home]); [reload] opens the
 * library again in the page, once it's moved or another is opened.
 */
class LibraryFolderService(
    private val home: StorageService,
    private val folders: Folders,
    private val chosen: Setting,
    private val reload: () -> Unit,
) {
    /** A setting kept across restarts. */
    interface Setting {
        fun get(): String?
        fun set(value: String?)
    }

    private class Open(val folder: String?, val root: LibraryTree, val data: LibraryTree, val placed: Boolean)

    @Volatile
    private var current: Open = openAt(null)

    /** A folder the library was in that the app may no longer use: it opened in its own storage instead. */
    private var lost: String? = null

    @Volatile
    private var moving = status("idle", 0, 0)

    init {
        val folder = chosen.get()
        if (folder != null) {
            if (folders.mayUse(folder)) current = openAt(folder) else lost = folder
        }
    }

    /** The storage the page reads and writes. */
    val root: LibraryTree get() = current.root

    /** Where the library's own files are: imports and fetched files are stored here. */
    val data: LibraryTree get() = current.data

    /** Whether the library is laid out in a folder of the user's. */
    val placed: Boolean get() = current.placed

    private fun openAt(folder: String?): Open {
        if (folder == null) return Open(null, home, home, false)
        val root = folders.open(folder)
        val placed = isPlaced(root)
        return Open(folder, root, if (placed) folders.open(folder, DATA_DIR) else root, placed)
    }

    fun location(): JSONObject {
        val open = current
        return JSONObject()
            .put("path", open.folder?.let(folders::where) ?: "")
            .put("isDefault", open.folder == null)
            .put("placed", open.placed)
            .put("defaultHasLibrary", open.folder != null && home.exists("library.json"))
            .apply { lost?.let { put("lost", folders.where(it)) } }
    }

    /** Asks for a folder: its id, where it is, and what's in it; null if none was chosen. */
    fun choose(): JSONObject? {
        val folder = folders.pick() ?: return null
        folders.keep(folder)
        return JSONObject().put("path", folder).put("name", folders.where(folder)).put("holds", holds(folders.open(folder)))
    }

    /**
     * Starts moving the library to [to] (the app's storage if null), laid out by [layout] with each
     * book file at its path in [placed]; [status] says how it's going. Once moved, the page reloads.
     */
    fun move(to: String?, layout: JSONObject?, placed: Map<String, String>) {
        if (moving.getString("state") == "moving") throw IllegalStateException("The library is moving already.")
        val from = current
        if (to != null && from.folder != null) {
            if (to == from.folder) throw IllegalArgumentException("The library is in that folder already.")
            if (folders.overlap(to, from.folder)) throw IllegalArgumentException("The library can’t move into its own folder, or into one its folder is in.")
        }
        if (to == null && from.folder == null) throw IllegalArgumentException("The library is in the app’s storage already.")
        moving = status("moving", 0, 0)
        Thread {
            try {
                val target = if (to == null) home else folders.open(to)
                relocate(from.root, from.placed, target, layout?.takeIf { to != null }, placed) { done, total ->
                    moving = status("moving", done, total)
                }
                switchTo(to)
                moving = status("done", moving.getInt("done"), moving.getInt("total"))
                reload()
            } catch (e: Exception) {
                moving = status("failed", moving.getInt("done"), moving.getInt("total")).put("message", e.message ?: e.toString())
            }
        }.apply { name = "library-move" }.start()
    }

    fun status(): JSONObject = moving

    /** Opens the library in [folder] (the app's storage if null), leaving this one where it is. */
    fun open(folder: String?) {
        if (folder != null && !folders.mayUse(folder)) throw IllegalStateException("nexlibris may not use that folder. Choose it again.")
        switchTo(folder)
        reload()
    }

    private fun switchTo(folder: String?) {
        current = openAt(folder)
        lost = null
        chosen.set(folder)
        // Only the library's folder is kept (and the sync folder, which isn't this service's).
        folders.releaseAllBut(setOfNotNull(folder))
    }

    private fun status(state: String, done: Int, total: Int) = JSONObject().put("state", state).put("done", done).put("total", total)

    companion object {
        const val DATA_DIR = ".nexlibris"
        const val LAYOUT_PATH = "$DATA_DIR/layout.json"
        const val PLACED_PATH = "$DATA_DIR/placed.json"
        private val HASH = Regex("[0-9a-f]{64}")

        /** Whether the tree holds a library laid out in it, rather than one kept as the app's storage keeps it. */
        fun isPlaced(tree: LibraryTree) = tree.exists(LAYOUT_PATH)

        /** What a folder holds already: a library, other files, or nothing. */
        fun holds(tree: LibraryTree): String = when {
            isPlaced(tree) || tree.exists("library.json") -> "library"
            tree.listAll("").any { it !in IGNORED_NAMES } -> "files"
            else -> "nothing"
        }

        /**
         * Moves a library between trees, as `relocate` in client/src/library/libraryFolder.ts does
         * in a browser: its own files, and each stored book file to its place by [layout] ([placed]),
         * or into `files/` if it has none or something else is there. Copied and checked, then the
         * originals deleted; if anything fails, the copies are deleted. Other files stay as they are.
         */
        fun relocate(
            from: LibraryTree,
            fromPlaced: Boolean,
            to: LibraryTree,
            layout: JSONObject?,
            placed: Map<String, String>,
            onProgress: (done: Int, total: Int) -> Unit = { _, _ -> },
        ) {
            val fromData = if (fromPlaced) "$DATA_DIR/" else ""
            val toData = if (layout != null) "$DATA_DIR/" else ""
            if (holds(to) == "library") throw IllegalArgumentException("That folder has a library already.")

            val sources = LinkedHashMap<String, String>()
            if (fromPlaced) {
                val index = from.readText(PLACED_PATH)?.let(::JSONObject) ?: JSONObject()
                for (hash in index.keys()) {
                    val path = index.getString(hash)
                    if (from.exists(path)) sources[hash] = path
                }
            }
            for (path in from.filesUnder("${fromData}files")) {
                val hash = path.substringAfterLast('/')
                if (HASH.matches(hash) && hash !in sources) sources[hash] = path
            }

            val steps = mutableListOf<Pair<String, String>>()
            val index = JSONObject()
            val claimed = mutableSetOf<String>()
            for ((hash, source) in sources) {
                val path = if (layout != null) placed[hash] else null
                if (path != null && claimed.add(path.lowercase()) && !to.exists(path)) {
                    index.put(hash, path)
                    steps += source to path
                } else {
                    steps += source to toData + storedFilePath(hash)
                }
            }
            for (name in listOf("library.json", "changes.jsonl")) if (from.exists(fromData + name)) steps += fromData + name to toData + name
            for (path in from.filesUnder("${fromData}local")) steps += path to toData + path.removePrefix(fromData)

            val written = mutableListOf<String>()
            try {
                for ((i, step) in steps.withIndex()) {
                    val (source, target) = step
                    (from.open(source) ?: throw IOException("Couldn’t read $source.")).use { to.writeStream(target, it) }
                    written += target
                    if (to.size(target) != from.size(source)) throw IOException("$target didn’t copy whole.")
                    onProgress(i + 1, steps.size)
                }
                if (layout != null) {
                    to.writeText(LAYOUT_PATH, layout.toString())
                    written += LAYOUT_PATH
                    to.writeText(PLACED_PATH, index.toString())
                    written += PLACED_PATH
                }
            } catch (e: Exception) {
                for (path in written) {
                    runCatching { to.remove(path) }
                    runCatching { to.prune(path) }
                }
                throw e
            }

            // Copied and checked: the originals go.
            if (fromPlaced) {
                for ((source, _) in steps) {
                    if (source.startsWith("$DATA_DIR/")) continue
                    from.remove(source)
                    from.prune(source)
                }
                from.removeTree(DATA_DIR)
            } else {
                from.removeTree("")
            }
        }
    }
}
