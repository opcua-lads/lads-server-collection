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
 * Driver for Sartorius balances using the PC-SBI protocol (ESC-based),
 * e.g. Quintix, Secura, Practum.
 * 
 * Provides:
 *   - getCurrentReading():   ESC P
 *   - tare():               ESC U
 *   - zero():               ESC V
 *   - getDeviceInfo():      ESC x1_, x2_, x3_, x4_
 *
 * Weight readings are always returned in grams.
 */

import { SerialBalance } from "./balance-serial";
import { BalanceReading, toGrams, DeviceInfo, BalanceResponseType, BalanceStatus } from "./balance";

export class SbiBalance extends SerialBalance {

    /**
     * Send a PC-SBI command with ESC prefix and CR/LF termination.
     */
    protected async sendEsc(cmd: string, waitMs = 200): Promise<string> {
        return this.sendCommand(`\x1b${cmd}`, waitMs);
    }

    /**
     * Request the current reading.
     * Examples of PC-SBI responses to ESC P:
     *   "G   +123.456 g"   (stable gross)
     *   "N   +23.456"      (unstable net, unit missing)
     */
    async getCurrentReading(): Promise<BalanceReading> {
        const response = await this.sendEsc("P");
        const l = response.length        
        if ((l === 22) || (l == 16)) {
            const short = (l == 16)
            const ofs = short?0:6
            const marker = short?"":response.slice(0, 6).trim()
            const sign = response.slice(ofs, ofs + 1)
            const value = response.slice(ofs + 1, ofs + 10).trim()
            const unit = response.slice(ofs + 11, ofs + 14).trim()
            const isTared = marker === "N"        // 'N' = net (tared), 'G' = gross (not tared)
            const stable = unit.length > 0
            const weight = toGrams(Number((sign + value).replace(/\[|\]/g, "")), unit || "g")
            const s = value.toLowerCase()
            const responseType = (s === "high")?BalanceResponseType.High:(s === "low")?BalanceResponseType.Low:BalanceResponseType.Reading
            return { weight, unit, stable, isTared, responseType }
        } else if ((l > 22) && (response.toLowerCase().includes("calibration"))) {
            this.calibrationReport = {
                timestamp: new Date(response.split(/\r\n/, 1)[0].replace(/\s+/, ' ')),
                report: response
            }
            return { weight: 0, unit: "g", stable: false, isTared: false, responseType: BalanceResponseType.Calibration, response: response}
        } else {
            if (l > 0) {
                console.log(response)
            }
            return undefined
        }

    }

    async checkStatus(): Promise<BalanceStatus> {
        if (!this.port.isOpen) return BalanceStatus.Offline
        const response = await this.sendEsc("X1")
        return response.length > 0?BalanceStatus.Online:BalanceStatus.Offline
    }

    /**
     * Set current gross as tare (subtract current load).
     */
    async tare(): Promise<void> {
        await this.sendEsc("U");
    }

    /**
     * Zero the balance explicitly (supported on most Sartorius models).
     */
    async zero(): Promise<void> {
        await this.sendEsc("V");
    }

    /**
     * Retrieve device information.
     *   x1_ : model/type
     *   x2_ : serial number
     *   x3_ : firmware/software version
     *   x4_ : hardware version
     */
    async getDeviceInfo(): Promise<DeviceInfo> {
        const info: DeviceInfo = { manufacturer: "Sartorius", model: "Unknown" };

        try {
            const m = await this.sendEsc("x1_");
            info.model = m.replace(/"/g, "").trim();
        } catch { }

        try {
            const s = await this.sendEsc("x2_");
            info.serialNumber = s.replace(/"/g, "").trim();
        } catch { }

        try {
            const f = await this.sendEsc("x3_");
            info.firmware = f.replace(/"/g, "").trim();
        } catch { }

        try {
            const h = await this.sendEsc("x4_");
            info.hardware = h.replace(/"/g, "").trim();
        } catch { }

        return info;
    }
}