package org.nexlibris.app

import android.content.ContentResolver
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import androidx.core.content.edit
import org.json.JSONObject

/**
 * The user's sync folder (common/src/usbFolderApi.ts): a folder in shared storage they pick once,
 * kept with a lasting permission, through which the phone syncs with a computer it's plugged into
 * by USB. [pick] shows the system's folder picker and waits for it (from the bridge's thread).
 */
class SyncFolderService(
    private val resolver: ContentResolver,
    private val prefs: SharedPreferences,
    private val pick: () -> Uri?,
) {
    private var cached: Pair<Uri, DocumentTreeStorage>? = null

    /** The folder, or an error saying to choose one. */
    fun folder(): DocumentTreeStorage {
        val tree = prefs.getString(PREF_TREE, null)?.let(Uri::parse) ?: throw IllegalStateException("Choose the sync folder first.")
        cached?.takeIf { it.first == tree }?.let { return it.second }
        if (resolver.persistedUriPermissions.none { it.uri == tree && it.isWritePermission }) {
            throw IllegalStateException("nexlibris may no longer use the sync folder. Choose it again.")
        }
        return DocumentTreeStorage(resolver, tree).also { cached = tree to it }
    }

    fun info(): JSONObject = JSONObject().put("path", runCatching { folder().where }.getOrNull() ?: JSONObject.NULL)

    /** Asks for the folder; returns where it is, or throws if none was chosen. */
    fun choose(): JSONObject {
        val tree = pick() ?: throw IllegalStateException("No folder was chosen.")
        val storage = DocumentTreeStorage(resolver, tree)
        resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        // Let go of the one it replaces, if it's another.
        prefs.getString(PREF_TREE, null)?.let(Uri::parse)?.takeIf { it != tree }?.let { old ->
            runCatching {
                resolver.releasePersistableUriPermission(old, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
        }
        prefs.edit { putString(PREF_TREE, tree.toString()) }
        cached = tree to storage
        return JSONObject().put("path", storage.where)
    }

    private companion object {
        const val PREF_TREE = "syncFolder"
    }
}
