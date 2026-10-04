package org.nexlibris.app

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.ParcelUuid
import android.util.Log
import androidx.core.content.edit
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/**
 * The app as a sync hub over Bluetooth LE (common/src/bluetoothApi.ts): a GATT server that
 * browsers and the desktop app connect to with Web Bluetooth. It only carries bytes: requests
 * are put back together from their chunks ([BluetoothFraming]) and handed to the page as events
 * ([next]), and the page's responses are sent back in chunks that fit each device's link ([send]).
 * Pairing, keys and the library are the page's (common/src/syncHub.ts).
 *
 * [prepare] makes Bluetooth usable before hosting starts: it asks for the permissions and to turn
 * Bluetooth on, and throws with a message if that fails. It's only ever called from the bridge's
 * threads, as it waits on the user. Everything here that needs a permission runs after it.
 */
@SuppressLint("MissingPermission")
class BluetoothHostService(
    private val context: Context,
    private val prefs: SharedPreferences,
    private val prepare: () -> Unit,
) {
    private val manager: BluetoothManager? = context.getSystemService(BluetoothManager::class.java)
    private val events = LinkedBlockingQueue<JSONObject>()
    private val links = ConcurrentHashMap<String, Link>()

    @Volatile private var server: BluetoothGattServer? = null
    @Volatile private var advertising = false
    @Volatile private var error: String? = null
    private var responses: BluetoothGattCharacteristic? = null

    /** One connected device: its link's size, its request in progress, and acknowledgements of what was sent. */
    private class Link(val device: BluetoothDevice) {
        @Volatile var mtu = DEFAULT_MTU
        @Volatile var subscribed = false
        val assembler = BluetoothFraming.Assembler()
        val prepared = ByteArrayOutputStream()
        val sent = LinkedBlockingQueue<Int>()
    }

    private val enabled get() = prefs.getBoolean(PREF_ENABLED, false)

    fun status(): JSONObject = JSONObject()
        .put("enabled", enabled)
        .put("running", server != null && advertising)
        .put("connected", links.size)
        .apply { adapterName()?.let { put("name", it) } }
        .apply { error?.let { put("error", it) } }

    @Synchronized
    fun setEnabled(on: Boolean): JSONObject {
        prefs.edit { putBoolean(PREF_ENABLED, on) }
        if (on) start() else stop()
        return status()
    }

    /** Waits up to [timeoutMs] for events; returns those there are. */
    fun next(timeoutMs: Long): JSONArray {
        val list = JSONArray()
        val first = events.poll(timeoutMs.coerceIn(0, MAX_WAIT_MS), TimeUnit.MILLISECONDS) ?: return list
        list.put(first)
        while (true) list.put(events.poll() ?: break)
        return list
    }

    /** Sends a whole message to [deviceId], a chunk at a time, each once the last is acknowledged. */
    fun send(deviceId: String, data: String) {
        val link = links[deviceId] ?: throw IOException("That device has disconnected.")
        val gatt = server ?: throw IOException("Bluetooth hosting is off.")
        val characteristic = responses ?: throw IOException("Bluetooth hosting is off.")
        if (!link.subscribed) throw IOException("That device isn't listening for responses.")
        link.sent.clear()
        for (chunk in BluetoothFraming.chunks(Base64.getDecoder().decode(data), link.mtu - ATT_HEADER)) {
            var attempts = 0
            while (!notify(gatt, link.device, characteristic, chunk)) {
                // The stack's queue is full: give it a moment.
                if (++attempts > 50 || !links.containsKey(deviceId)) throw IOException("Couldn't send to that device.")
                Thread.sleep(20)
            }
            val status = link.sent.poll(SEND_TIMEOUT_S, TimeUnit.SECONDS) ?: throw IOException("That device stopped answering.")
            if (status != BluetoothGatt.GATT_SUCCESS) throw IOException("Sending to that device failed ($status).")
        }
    }

    private fun notify(gatt: BluetoothGattServer, device: BluetoothDevice, characteristic: BluetoothGattCharacteristic, value: ByteArray): Boolean =
        if (Build.VERSION.SDK_INT >= 33) {
            gatt.notifyCharacteristicChanged(device, characteristic, false, value) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            characteristic.value = value
            @Suppress("DEPRECATION")
            gatt.notifyCharacteristicChanged(device, characteristic, false)
        }

    /** Starts hosting, if it isn't already. Called again when the app opens, if it was left on. */
    private fun start() {
        if (server != null) return
        error = null
        try {
            prepare()
            val adapter = manager?.adapter ?: throw IllegalStateException("This device has no Bluetooth.")
            if (!adapter.isEnabled) throw IllegalStateException("Bluetooth is off.")
            val advertiser = adapter.bluetoothLeAdvertiser
                ?: throw IllegalStateException("This device can't be found over Bluetooth LE (it can't advertise).")
            val gatt = manager.openGattServer(context, callback) ?: throw IllegalStateException("Couldn't start Bluetooth hosting.")
            val characteristic = BluetoothGattCharacteristic(
                RESPONSES,
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ,
            ).apply {
                addDescriptor(
                    BluetoothGattDescriptor(
                        CLIENT_CONFIG,
                        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
                    ),
                )
            }
            val service = BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY).apply {
                addCharacteristic(
                    BluetoothGattCharacteristic(
                        REQUESTS,
                        BluetoothGattCharacteristic.PROPERTY_WRITE,
                        BluetoothGattCharacteristic.PERMISSION_WRITE,
                    ),
                )
                addCharacteristic(characteristic)
            }
            responses = characteristic
            server = gatt
            // Advertised once the service is in place (onServiceAdded), so no one connects to an empty server.
            pendingAdvertiser = advertiser
            if (!gatt.addService(service)) throw IllegalStateException("Couldn't start Bluetooth hosting.")
        } catch (e: Exception) {
            error = e.message ?: e.toString()
            stop(keepError = true)
        }
    }

    private fun advertise(advertiser: android.bluetooth.le.BluetoothLeAdvertiser, withName: Boolean) {
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build()
        val data = AdvertiseData.Builder().addServiceUuid(ParcelUuid(SERVICE)).build()
        // The name goes in the scan response, which browsers show in their device chooser.
        val scanResponse = AdvertiseData.Builder().setIncludeDeviceName(withName).build()
        advertiser.startAdvertising(settings, data, scanResponse, object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
                advertising = true
                error = null
            }

            override fun onStartFailure(errorCode: Int) {
                if (errorCode == ADVERTISE_FAILED_DATA_TOO_LARGE && withName) {
                    // A long Bluetooth name doesn't fit: advertise without it.
                    advertise(advertiser, withName = false)
                    return
                }
                advertising = false
                error = "Couldn't advertise over Bluetooth (error $errorCode)."
                Log.w(TAG, "Advertising failed: $errorCode")
            }
        }.also { advertiseCallback = it })
    }

    private var advertiseCallback: AdvertiseCallback? = null
    @Volatile private var pendingAdvertiser: android.bluetooth.le.BluetoothLeAdvertiser? = null

    @Synchronized
    fun stop(keepError: Boolean = false) {
        try {
            advertiseCallback?.let { manager?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(it) }
            server?.close()
        } catch (e: SecurityException) {
            Log.w(TAG, "Stopping without permission", e)
        }
        advertiseCallback = null
        pendingAdvertiser = null
        advertising = false
        server = null
        responses = null
        links.clear()
        if (!keepError) error = null
    }

    /** Resumes hosting when the app opens, if it was left on and needs no questions asked. */
    fun resume() {
        if (enabled) Thread { synchronized(this) { start() } }.start()
    }

    private fun adapterName(): String? = try {
        manager?.adapter?.name
    } catch (_: SecurityException) {
        null
    }

    private val callback = object : BluetoothGattServerCallback() {
        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            val advertiser = pendingAdvertiser ?: return
            pendingAdvertiser = null
            if (status == BluetoothGatt.GATT_SUCCESS) advertise(advertiser, withName = true)
            else error = "Couldn't start Bluetooth hosting (error $status)."
        }

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                links[device.address] = Link(device)
                events.put(JSONObject().put("kind", "connected").put("device", device.address))
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                links.remove(device.address)?.sent?.put(BluetoothGatt.GATT_FAILURE)
                events.put(JSONObject().put("kind", "disconnected").put("device", device.address))
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            links[device.address]?.mtu = mtu
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            links[device.address]?.sent?.put(status)
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            val ok = descriptor.uuid == CLIENT_CONFIG && descriptor.characteristic.uuid == RESPONSES
            if (ok) links[device.address]?.subscribed = value?.isNotEmpty() == true && value[0].toInt() and 1 == 1
            if (responseNeeded) {
                server?.sendResponse(device, requestId, if (ok) BluetoothGatt.GATT_SUCCESS else BluetoothGatt.GATT_FAILURE, 0, null)
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            val link = links[device.address]
            if (characteristic.uuid != REQUESTS || link == null || value == null) {
                if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
                return
            }
            if (preparedWrite) {
                // A long write (more than fits the link at once) arrives in parts, delivered on execute.
                if (offset != link.prepared.size()) link.prepared.reset()
                link.prepared.write(value)
                if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                return
            }
            deliver(link, value)
            if (responseNeeded) server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
        }

        override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
            val link = links[device.address]
            if (link != null) {
                if (execute) deliver(link, link.prepared.toByteArray())
                link.prepared.reset()
            }
            server?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
        }
    }

    private fun deliver(link: Link, chunk: ByteArray) {
        val message = link.assembler.push(chunk) ?: return
        events.put(
            JSONObject().put("kind", "message").put("device", link.device.address)
                .put("data", Base64.getEncoder().encodeToString(message)),
        )
    }

    companion object {
        private const val TAG = "BluetoothHost"
        private const val PREF_ENABLED = "bluetoothHosting"
        private const val DEFAULT_MTU = 23
        /** Bytes of each notification taken by the protocol's own header. */
        private const val ATT_HEADER = 3
        private const val MAX_WAIT_MS = 30_000L
        private const val SEND_TIMEOUT_S = 10L
        val SERVICE: UUID = UUID.fromString("4e28ef00-8886-467b-9c6a-a0b49a90cf89")
        val REQUESTS: UUID = UUID.fromString("75b3ab92-7677-4775-96eb-6df34e2ea9fe")
        val RESPONSES: UUID = UUID.fromString("9a47303a-9028-4737-af10-810a6f50a363")
        /** The standard descriptor a client writes to subscribe to notifications. */
        val CLIENT_CONFIG: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
}
