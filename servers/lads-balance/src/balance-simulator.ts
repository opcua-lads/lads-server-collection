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
*  Simulated Balance Implementation
*/

import { Balance, BalanceReading, DeviceInfo, BalanceStatus, BalanceEvents, BalanceTareMode } from "./balance";

export async function waitForCondition(
    condition: () => boolean | Promise<boolean>,
    timeoutMs: number = 5000,
    intervalMs: number = 200
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const interval = setInterval(async () => {
            try {
                if (await condition()) {
                    clearInterval(interval)
                    clearTimeout(timeout)
                    resolve();
                }
            } catch (err) {
                clearInterval(interval)
                clearTimeout(timeout)
                reject(err)
            }
        }, intervalMs)
        const timeout = setTimeout(() => {
            clearInterval(interval)
            reject(new Error('Timeout expired while waiting for condition.'))
        }, timeoutMs)

    })
}

export class SimulatedBalance extends Balance {
    getRawWeight: () => number
    status = BalanceStatus.Offline
    rawWeight = 0
    zeroWeight = 0
    tareWeight = 0

    constructor(getRawWeight: () => number) {
        super()
        this.getRawWeight = getRawWeight
    }

    async connect(): Promise<void> {
        this.status = BalanceStatus.Online
        const info = await this.getDeviceInfo()
        if (info) this.emit(BalanceEvents.DeviceInfo, info)
        const reading = await this.getCurrentReading()
        if (reading) this.emit(BalanceEvents.Reading, reading)
    }
    async tryReconnect(): Promise<void> {}

    async disconnect(): Promise<void> {
        this.status = BalanceStatus.Online
    }
    async getStatus(): Promise<BalanceStatus> {
        return this.status
    }

    get grossWeight(): number { return this.rawWeight - this.zeroWeight }
    get netWeight(): number { return this.grossWeight - this.tareWeight }

    async getCurrentReading(): Promise<BalanceReading> {
        const rawValue = this.getRawWeight()
        const stable = Math.abs(this.rawWeight - rawValue) < 0.01
        const tareMode = (Math.abs(this.tareWeight) < 0.001) ? BalanceTareMode.None : BalanceTareMode.Manual
        this.rawWeight = rawValue
        const unit = "g"
        const weight = this.netWeight
        return { weight, unit, stable, tareMode: tareMode };
    }

    async setTare(): Promise<void> {
        return waitForCondition(async (): Promise<boolean> => {
            const reading = await this.getCurrentReading()
            if (reading.stable) {
                this.tareWeight = this.grossWeight
                return true
            } else {
                return false
            }
        })
    }

    async setZero(): Promise<void> {
        return waitForCondition(async (): Promise<boolean> => {
            const reading = await this.getCurrentReading()
            if (reading.stable) {
                this.zeroWeight = this.rawWeight
                return true
            } else {
                return false
            }
        })
    }

    async getDeviceInfo(): Promise<DeviceInfo> {
        const info: DeviceInfo = { manufacturer: "AixEngineers", model: "SuperBalance 2030", firmware: "1.0", hardware: "1.0", serialNumber: "47110815" }
        return info
    }
}