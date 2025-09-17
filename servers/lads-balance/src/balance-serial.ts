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

import { SerialPort } from "serialport";
import { Balance, BalanceStatus, BalanceEvents } from "./balance";

export abstract class SerialBalance extends Balance {
    protected port: SerialPort;
    protected buffer = "";
    private statusCheck?: NodeJS.Timeout;
    private lastStatus?: BalanceStatus;
    private threshold = 5
    private counter = 0

    constructor(portPath: string, baudRate = 9600) {
        super();
        this.port = new SerialPort({ path: portPath, baudRate });
    }

    private tryReconnect() {
        try { this.port.open()}  
        catch {}
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

                    //this.startStatusMonitor();

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
        if (this.statusCheck) clearInterval(this.statusCheck);
        this.port.close();
    }

    /**
     * Returns Online if the serial port is open, otherwise Offline.
     */
    async getStatus(): Promise<BalanceStatus> {
        return this.port.isOpen ? BalanceStatus.Online : BalanceStatus.Offline;
    }

    /**
     * Sends a command terminated with CRLF and waits a short time
     * for the balance to reply, returning the trimmed response string.
     */
    protected async sendCommand(cmd: string, waitMs = 200): Promise<string> {
        this.buffer = "";
        this.port.write(cmd + "\r\n");
        await new Promise(res => setTimeout(res, waitMs))
        const l = this.buffer.length
        if (l === 0) {
            this.counter++
            if (this.lastStatus === BalanceStatus.Offline) {
                this.tryReconnect()
            }  else if (this.counter > this.threshold) {
                this.lastStatus = BalanceStatus.Offline
                this.emit(BalanceEvents.Status, BalanceStatus.Offline)
            }
        } else {
            if (this.lastStatus === BalanceStatus.Offline) {
                this.lastStatus = BalanceStatus.Online
                this.emit(BalanceEvents.Status, BalanceStatus.Online)                
            }
            this.counter = 0
        }
        return this.buffer
    }

}
