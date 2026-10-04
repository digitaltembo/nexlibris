package org.nexlibris.app

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import java.io.IOException

/** A document in a picked folder, as the storage provider lists it. */
data class TreeEntry(val id: String, val name: String, val isFolder: Boolean, val size: Long = 0)

/** A file found in a picked folder: its document id, its path from the folder's name on, and its size. */
data class FolderFile(val id: String, val path: String, val size: Long)

/**
 * The files in a folder and its subfolders, each path starting with the folder's
 * name, in name order. Hidden files and folders (a leading dot) are left out, as a computer hides
 * them. [children] lists a folder's documents by its id.
 */
fun walkFolder(rootId: String, rootName: String, children: (String) -> List<TreeEntry>): List<FolderFile> {
    val files = mutableListOf<FolderFile>()
    fun visit(id: String, path: String) {
        for (entry in children(id).sortedBy { it.name }) {
            if (entry.name.startsWith(".")) continue
            if (entry.isFolder) visit(entry.id, "$path/${entry.name}") else files.add(FolderFile(entry.id, "$path/${entry.name}", entry.size))
        }
    }
    visit(rootId, rootName)
    return files
}

/** The files of a folder picked with the system's folder picker, to import; each is opened only when it's read. */
fun documentTreeFiles(resolver: ContentResolver, tree: Uri): List<PickedSource> {
    val rootId = DocumentsContract.getTreeDocumentId(tree)
    val rootName = resolver.query(
        DocumentsContract.buildDocumentUriUsingTree(tree, rootId),
        arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null,
    )?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "Folder"
    val columns = arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
    )
    val children = { id: String ->
        resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, id), columns, null, null, null)?.use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val folder = cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR
                    add(TreeEntry(cursor.getString(0), cursor.getString(1), folder, if (cursor.isNull(3)) 0 else cursor.getLong(3)))
                }
            }
        } ?: emptyList()
    }
    return walkFolder(rootId, rootName, children).map { (id, path, size) ->
        PickedSource(path.substringAfterLast('/'), path, size) {
            val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)
            resolver.openInputStream(uri) ?: throw IOException("Couldn't open $path")
        }
    }
}
