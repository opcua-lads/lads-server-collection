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
    DeviceInfo: Symbol("deviceInfo"),
    Reading: Symbol("reading"),
    Status: Symbol("status"),
    Error: Symbol("error"),
} as const;

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
    protected emitter = new EventEmitter()

    constructor() { super() }

    abstract connect(): Promise<void>;
    abstract disconnect(): Promise<void>;

    abstract getStatus(): Promise<BalanceStatus>;
    abstract getCurrentReading(): Promise<BalanceReading>;

    abstract tare(): Promise<void>;
    abstract zero(): Promise<void>;

    abstract getDeviceInfo?(): Promise<DeviceInfo>;
    /**
     * Subscribe to an event such as DeviceInfo, Reading, Status, or Error.
     */
    on<K extends keyof BalanceEventMap>(
        event: K,
        listener: (arg: BalanceEventMap[K]) => void
    ): this {
        this.emitter.on(event, listener);
        return this;
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

