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
 * Driver for Mettler Toledo balances using the MT-SICS protocol.
 *
 * Key commands used:
 *   - SI  : Send immediate weight (stable/unstable, net)
 *   - TA  : Query current tare value (for isTared and optional tare amount)
 *   - T   : Set current gross as tare
 *   - Z   : Zero the balance
 *   - I2  : Model/type and capacity
 *   - I3  : Software version and type definition
 *   - I4  : Serial number
 *   - I10 : User-defined device ID (optional)
 */

import { SerialBalance } from "./balance-serial";
import { BalanceReading, toGrams, DeviceInfo, BalanceStatus, BalanceTareMode } from "./balance";

export class SicsBalance extends SerialBalance {
    /**
     * Query current weight and tare status.
     * Polls SI for weight and TA for tare info.
     */
    status: BalanceStatus
    tareMode: BalanceTareMode = BalanceTareMode.None

    get supportsPresetTare(): boolean { return true }

    async getCurrentReading(): Promise<BalanceReading> {
        // Current weight (and stable/unstable) from SI
        const siResp = await this.sendCommand("SI");
        const m = siResp.match(/S\s+([SD])\s+([+-]?\d+(?:\.\d+)?)\s*(\w+)/);
        if (!m) {
            if (siResp.trim() == "EL") {
                this.status = BalanceStatus.StandBy
            } else if (siResp.length === 0) {
                this.status = BalanceStatus.Offline
            } else {
                // status is unclear - don't change it
                console.debug(`Unknown SICS SI response: ${siResp}`)
            }
            return undefined
        } else {
            this.status = BalanceStatus.Online
            const stable = m[1] === "S";
            const unit = m[3];
            const weight = toGrams(Number(m[2]), unit);

            // Current tare value from TA (to determine if tared)
            const taResp = await this.sendCommand("TA");
            const tMatch = taResp.match(/^TA\s+A\s+([+-]?\d+(?:\.\d+)?)\s*(\w+)/);
            const tareWeight = tMatch ? toGrams(Number(tMatch[1]), tMatch[2]) : undefined
            if (tMatch) {
                if  (Math.abs(tareWeight) < 1e-6) {
                    this.tareMode = BalanceTareMode.None
                } else if (this.tareMode === BalanceTareMode.None) {
                    this.tareMode = BalanceTareMode.Manual
                }
            }

            return {
                weight,
                unit,
                stable,
                tareMode: this.tareMode,
                tareWeight
            }
        }
    }

    async getStatus(): Promise<BalanceStatus> {
        if (!this.port) return BalanceStatus.Offline
        if (!this.port.isOpen) return BalanceStatus.Offline
        return this.status
    }

    /**
     * Zero the balance
     */
    async zero(): Promise<void> {
        await this.sendCommand("Z");
        this.tareMode = BalanceTareMode.None
    }

    /**
     * Set current gross as tare
     */
    async tare(): Promise<void> {
        await this.sendCommand("T");
        this.tareMode = BalanceTareMode.Manual
    }

    async clearTare(): Promise<void> { 
        await this.sendCommand(`TAC`)
        this.tareMode = BalanceTareMode.None
    }

    async presetTare(tare: number): Promise<void> { 
        await this.sendCommand(`TA ${tare.toFixed(2)} g`)
        this.tareMode = BalanceTareMode.Preset
    }


    /**
     * Retrieve device identification and firmware info.
     *   I2  -> Model/type and capacity
     *   I3  -> Software version and type definition
     *   I4  -> Serial number
     */

    async getDeviceInfo(): Promise<DeviceInfo> {
        const info: DeviceInfo = {
            manufacturer: "Mettler Toledo",
            model: "Unknown",
        };
        try {
            const respI2 = await this.sendCommand("I2");
            const m = respI2.slice(5).replaceAll('"', "")
            if (m) info.model = m.trim();
        } catch { }

        try {
            const respI3 = await this.sendCommand("I3");
            const v = respI3.slice(5).replaceAll('"', "")
            if (v) info.firmware = v.trim();
        } catch { }

        try {
            const respI4 = await this.sendCommand("I4");
            const s = respI4.slice(5).replaceAll('"', "")
            if (s) info.serialNumber = s.trim();
        } catch { }

        return info;
    }
}
