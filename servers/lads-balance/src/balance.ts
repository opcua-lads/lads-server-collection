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
 * Common types and base class for all balance drivers.
 */

import EventEmitter from "events";

export enum BalanceStatus {
    Offline = "offline",
    Online = "online",
}

export enum BalanceResponseType { Reading, High, Low, Calibration, Other}

/**
 * A single weight reading from a balance.
 * weight is always expressed in grams (normalized),
 * unit is the native engineering unit reported (often "g"),
 * stable indicates whether the reading is stable,
 * isTared tells whether the displayed weight is net (true) or gross (false).
 */
export interface BalanceReading {
    weight: number
    unit: string
    stable: boolean
    isTared: boolean
    responseType?: BalanceResponseType
    response?: string
}

/**
 * Device identification and software information.
 * Some fields (firmware, hardware, userId) may be undefined
 * depending on the specific balance model and protocol.
 */
export interface DeviceInfo {
    manufacturer: string
    model: string
    serialNumber?: string
    firmware?: string
    hardware?: string
}

/**
 * Strongly typed event names as symbols.
 * Using symbols avoids hard-coded strings in the code base.
 */
export const BalanceEvents = {
    DeviceInfo: "deviceInfo",
    Reading: "reading",
    Status: "status",
    Error: "error",
} as const;

export type BalanceEventKey = typeof BalanceEvents[keyof typeof BalanceEvents]

/**
 * Type mapping each event symbol to the payload type
 * so listeners can be type-checked.
 */
export type BalanceEventMap = {
    [BalanceEvents.DeviceInfo]: DeviceInfo;
    [BalanceEvents.Reading]: BalanceReading;
    [BalanceEvents.Status]: BalanceStatus;
    [BalanceEvents.Error]: Error;
};


/**
 * Abstract base class for all balances.
 * Concrete subclasses must implement the protocol-specific commands.
 */
export abstract class Balance extends EventEmitter{
    private polling?: NodeJS.Timeout
    calibrationTimestamp?: Date
    calibrationReport?: string

    constructor() { super() }

    abstract connect(): Promise<void>;
    async disconnect(): Promise<void> {
        if (this.polling) clearInterval(this.polling)
    }

    abstract getStatus(): Promise<BalanceStatus>;
    abstract getCurrentReading(): Promise<BalanceReading>;

    abstract tare(): Promise<void>;
    abstract zero(): Promise<void>;

    abstract getDeviceInfo?(): Promise<DeviceInfo>;

    /**
     * Start automatic polling of weight readings at the given interval.
     * Emits BalanceEvents.Reading for every successful reading.
     */
    startPolling(intervalMs = 1000): void {
        if (this.polling) clearInterval(this.polling);
        this.polling = setInterval(async () => {
            try {
                const reading = await this.getCurrentReading();
                if (reading){
                    this.emit(BalanceEvents.Reading, reading);                
                } else {
                    this.emit(BalanceEvents.Error, "Invalid reading");
                }
            } catch (e) {}
        }, intervalMs);
    }

}

/**
 * Helper to normalize a value to grams from common mass units.
 */
export function toGrams(value: number, unit: string): number {
    switch (unit.toLowerCase()) {
        case "kg": return value * 1000;
        case "g": return value;
        case "mg": return value / 1000;
        case "µg":
        case "ug": return value / 1_000_000;
        default: return value; // leave unchanged if unknown
    }
}

