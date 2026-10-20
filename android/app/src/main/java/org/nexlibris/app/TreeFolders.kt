package org.nexlibris.app

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.core.net.toUri

/**
 * Folders picked with the system's folder picker ([Folders], for [LibraryFolderService]), by tree
 * URI. Picking one grants the app that folder only, kept across restarts with a lasting permission:
 * no storage permission is needed. [pick] shows the picker and waits (from the bridge's thread);
 * [alsoKeep] names folders whose permission another service holds (the sync folder).
 */
class TreeFolders(
    private val resolver: ContentResolver,
    private val pick: () -> Uri?,
    private val alsoKeep: () -> Set<String>,
) : Folders {
    override fun pick(): String? = pick.invoke()?.also { DocumentTreeStorage(resolver, it) }?.toString()

    override fun open(id: String, base: String): LibraryTree = DocumentTreeStorage(resolver, id.toUri(), base)

    override fun where(id: String): String = DocumentTreeStorage(resolver, id.toUri()).where

    override fun mayUse(id: String): Boolean {
        val tree = id.toUri()
        if (resolver.persistedUriPermissions.none { it.uri == tree && it.isWritePermission }) return false
        // The folder may have been deleted since.
        return runCatching {
            val uri = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
            resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)?.use { it.moveToFirst() } == true
        }.getOrDefault(false)
    }

    override fun keep(id: String) = resolver.takePersistableUriPermission(id.toUri(), FLAGS)

    override fun releaseAllBut(ids: Set<String>) {
        val kept = ids + alsoKeep()
        for (permission in resolver.persistedUriPermissions) {
            if (permission.uri.toString() !in kept) runCatching { resolver.releasePersistableUriPermission(permission.uri, FLAGS) }
        }
    }

    override fun overlap(a: String, b: String): Boolean {
        val (x, y) = listOf(a, b).map { DocumentsContract.getTreeDocumentId(it.toUri()).trimEnd('/') }
        return x == y || x.startsWith(if (y.endsWith(":")) y else "$y/") || y.startsWith(if (x.endsWith(":")) x else "$x/")
    }

    private companion object {
        const val FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    }
}
