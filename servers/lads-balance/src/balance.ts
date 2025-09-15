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
    weight: number;
    unit: string;
    stable: boolean;
    isTared: boolean;
}

/**
 * Device identification and software information.
 * Some fields (firmware, hardware, userId) may be undefined
 * depending on the specific balance model and protocol.
 */
export interface DeviceInfo {
    manufacturer: string;
    model: string;
    serialNumber?: string;
    firmware?: string;
    hardware?: string;
    userId?: string;
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

    constructor(public readonly id: string) { super() }

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

