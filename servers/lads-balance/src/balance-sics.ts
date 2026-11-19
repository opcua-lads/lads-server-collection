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

//import { SerialBalance } from "./balance-serial";

import { BalanceReading, toGrams, DeviceInfo, BalanceStatus, BalanceTareMode, BalanceEvents, getDecimalDigits } from "./balance";
import { StreamBalance } from "./balance-stream";

/** Mnemonic of the response to a command: SI and SIR answer with "S", all others with their own name (I4 -> "I4", TA -> "TA"). */
function sicsResponseMnemonic(cmd: string): string {
    const name = cmd.trim().split(/\s+/)[0].toUpperCase()
    return (name === "SI" || name === "SIR") ? "S" : name
}

/**
 * The text of an "I<n> A <text>" response: without the quotes, undefined if the command was not executed (I4 I, ES, ET, EL)
 * or the response is not the one of this command.
 */
export function sicsInfoText(response: string, mnemonic: string): string | undefined {
    const m = response.trim().match(new RegExp(`^${mnemonic}\\s+[AB]\\s+(.*)$`, "i"))
    if (!m) return undefined
    const text = m[1].replace(/^"(.*)"$/, "$1").replace(/"/g, "").trim()
    return text.length > 0 ? text : undefined
}

export class SicsBalance extends StreamBalance {
    status: BalanceStatus
    presetTare: number = 0

    /** Sends a SICS command and returns its response line (one line per command; late replies of other commands are discarded). */
    protected async sics(cmd: string): Promise<string> {
        const expected = sicsResponseMnemonic(cmd)
        return this.requestLine(cmd, line => {
            const token = line.trim().split(/\s+/)[0].toUpperCase()
            return token === expected || token === "ES" || token === "ET" || token === "EL"
        })
    }

    get supportsPresetTare(): boolean { return true }

    async getCurrentReading(): Promise<BalanceReading> {

        // Current weight (and stable/unstable) from SI
        const siResp = await this.sics("SI");
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
            const unit = m[3].trim()
            const value = m[2].trim()
            if ((unit == "g") && (this.digits == undefined)) {
                this.digits = getDecimalDigits(value)
                this.emit(BalanceEvents.Digits, this.digits)
            }
            const weight = toGrams(Number(value), unit);

            // Current tare value from TA (to determine if tared)
            const taResp = await this.sics("TA");
            const tMatch = taResp.match(/^TA\s+A\s+([+-]?\d+(?:\.\d+)?)\s*(\w+)/);
            const tareWeight = tMatch ? toGrams(Number(tMatch[1]), tMatch[2]) : undefined
            let tareMode = BalanceTareMode.None
            if (tareWeight) {
                if (Math.abs(tareWeight) > 1e-6) {
                    // balance is tared
                    tareMode = (Math.abs(tareWeight - this.presetTare) > 1e-6) ? BalanceTareMode.Manual : BalanceTareMode.Preset
                }
            }

            return {
                weight,
                unit,
                stable,
                tareMode,
                tareWeight,
            }
        }
    }

    async getStatus(): Promise<BalanceStatus> {
        if (!this.transport.isOpen) return BalanceStatus.Offline
        return this.status ?? BalanceStatus.Online
    }

    /*async getStatus(): Promise<BalanceStatus> {
        if (!this.port) return BalanceStatus.Offline
        if (!this.port.isOpen) return BalanceStatus.Offline
        return this.status
    }*/

    /**
     * Zero the balance
     */
    async setZero(): Promise<void> {
        await this.sics("Z");
    }

    /**
     * Set current gross as tare
     */
    async setTare(): Promise<void> {
        await this.sics("T");
    }

    async clearTare(): Promise<void> {
        await this.sics(`TAC`)
        this.presetTare = 0
    }

    async setPresetTare(oresetTare: number): Promise<void> {
        await this.sics(`TA ${oresetTare.toFixed(2)} g`)
        this.presetTare = oresetTare
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
            deviceTypeImage: "mettler_toledo_ms.png"
        }

        try {
            const respI2 = await this.sics("I2");
            const m = sicsInfoText(respI2, "I2")
            if (m) {
                info.model = m.trim()
                if (info.model.startsWith("CUB")) {
                    info.manufacturer = "Sartorius"
                    info.deviceTypeImage = "sartorius_cubis.png"
                }
            }
        } catch { 
            info.manufacturer = undefined
            info.model = undefined
            info.deviceTypeImage = undefined
        }

        try {
            const respI3 = await this.sics("I3");
            const v = sicsInfoText(respI3, "I3")
            console.log('Received Firmware:', v);
            if (v) info.firmware = v.trim();
        } catch {  }

        try {
            const respI4 = await this.sics("I4");
            const s = sicsInfoText(respI4, "I4")
            console.log('Received Serial:', s);
            if (s) info.serialNumber = s.trim();
        } catch { 
            info.serialNumber = undefined
        }

        return info;
    }
}
