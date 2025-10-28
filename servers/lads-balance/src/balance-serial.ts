// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Balance
Copyright (C) 2025  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/**
 * Base class for balances communicating over a serial port.
 * Handles connect/disconnect, background polling and event emission.
 * Protocol-specific subclasses only need to implement:
 *   - getCurrentReading()
 *   - tare()
 *   - zero()
 *   - getDeviceInfo() (optional)
 */

import { SerialPort, SerialPortOpenOptions } from "serialport";
import { Balance, BalanceStatus, BalanceEvents } from "./balance";
import { statSync } from "fs"

export abstract class SerialBalance extends Balance {
    private opLock: Promise<void> = Promise.resolve()
    protected options: SerialPortOpenOptions<any>
    protected port: SerialPort
    protected buffer = ""

    static isSerialPortAvailable(path: string): boolean {
        try {
            // Check if the path exists and is a character device
            const stats = statSync(path)
            return stats.isCharacterDevice();
        } catch {
            return false
        }
    }

    constructor(options: SerialPortOpenOptions<any>) {
        super()
        this.options = options
        // start online/offline status
        this.startCheckStatus()
    }

    async tryReconnect(): Promise<void> {
        try {
            if (!this.port) {
                const path = this.options.path
                if (SerialBalance.isSerialPortAvailable(path)) {
                    this.port = new SerialPort(this.options)
                    this.connect()
                } else {
                    this.emit(BalanceEvents.Error, `Serialport ${path} not avilable!`)
                }
            } else {
                this.port.on("error", (err) => {console.error("Error opening serial port ", this.port, err)})
                this.port.open()
            }
        }
        catch { }
    }

    /**
     * Opens the serial port and starts status monitoring.
     * Emits an initial DeviceInfo (if supported) and an initial Reading.
     */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.port.on("open", async () => {
                try {
                    if (this.getDeviceInfo) {
                        const info = await this.getDeviceInfo();
                        if (info) this.emit(BalanceEvents.DeviceInfo, info);
                    }

                    // Send one initial reading so callers get immediate data.
                    try {
                        const reading = await this.getCurrentReading();
                        this.emit(BalanceEvents.Reading, reading);
                    } catch (e) {
                        this.emit(BalanceEvents.Error, e);
                    }
                } finally {
                    resolve();
                }
            });

            this.port.on("error", reject);
            this.port.on("data", (d: Buffer) => {
                this.buffer += d.toString("utf-8");
            });
        });
    }

    /**
     * Closes the port and stops background tasks.
     */
    async disconnect(): Promise<void> {
        await super.disconnect()
        this.port.close();
    }

    /**
     * Returns Online if the serial port is open, otherwise Offline.
     */
    async getStatus(): Promise<BalanceStatus> {
        if (!this.port) return BalanceStatus.Offline
        return this.port.isOpen ? BalanceStatus.Online : BalanceStatus.Offline;
    }

    /**
     * Sends a command terminated with CRLF and waits a short time
     * for the balance to reply, returning the trimmed response string.
     */
    protected async sendCommand(cmd: string, waitMs = 200): Promise<string> {
        // Serialize all access to the port to avoid polling vs. command races
        const run = async () => {
            this.buffer = ""
            this.port.write(cmd + "\r\n")
            await new Promise(res => setTimeout(res, waitMs))
            return this.buffer
        }

        // chain onto the lock
        let unlock!: () => void
        const next = new Promise<void>(res => (unlock = res))
        const prev = this.opLock
        this.opLock = this.opLock.then(() => next)

        try {
            await prev           // wait for previous op
            return await run()   // do our I/O exclusively
        } finally {
            unlock()             // release for the next op
        }
    }
}
