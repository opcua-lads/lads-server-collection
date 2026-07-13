// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Balance
Copyright (C) 2025 - 2026  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

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

import { Balance, BalanceEvents, BalanceStatus } from "./balance";
import { BalanceTransport } from "./balance-transport";

//---------------------------------------------------------------
// Base class for command/response balances over any byte-stream transport.
// The protocol implementation is independent of USB/VCOM versus TCP/IP.
//---------------------------------------------------------------
export abstract class StreamBalance extends Balance {
    private opLock: Promise<void> = Promise.resolve();
    private buffer = "";
    private listenersAttached = false;

    public constructor(
        protected readonly transport: BalanceTransport,
        private readonly commandTerminator = "\r\n",
    ) {
        super();
        this.attachTransportListeners();
        this.startCheckStatus();
    }

    private attachTransportListeners(): void {
        if (this.listenersAttached) return;
        this.listenersAttached = true;

        this.transport.on("data", data => {
            this.buffer += data.toString("utf8");
        });

        this.transport.on("error", error => {
            this.emit(BalanceEvents.Error, error);
        });
    }

    public async tryReconnect(): Promise<void> {
        if (this.transport.isOpen) return;

        try {
            await this.connect();
        } catch (error) {
            this.emit(BalanceEvents.Error, error);
        }
    }

    public async connect(): Promise<void> {
        await this.transport.open();

        try {
            const info = await this.getDeviceInfo?.();
            if (info) this.emit(BalanceEvents.DeviceInfo, info);
        } catch (error) {
            this.emit(BalanceEvents.Error, error);
        }

        try {
            const reading = await this.getCurrentReading();
            if (reading) this.emit(BalanceEvents.Reading, reading);
        } catch (error) {
            this.emit(BalanceEvents.Error, error);
        }
    }

    public async disconnect(): Promise<void> {
        await super.disconnect();
        await this.transport.close();
    }

    public async getStatus(): Promise<BalanceStatus> {
        return this.transport.isOpen
            ? BalanceStatus.Online
            : BalanceStatus.Offline;
    }

    protected async sendCommand(cmd: string, waitMs = 200): Promise<string> {
        return this.withOperationLock(async () => {
            if (!this.transport.isOpen) {
                throw new Error("Balance transport is not connected");
            }

            this.buffer = "";
            await this.transport.write(cmd + this.commandTerminator);
            await new Promise<void>(resolve => setTimeout(resolve, waitMs));
            return this.buffer;
        });
    }

    private async withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
        let unlock!: () => void;
        const gate = new Promise<void>(resolve => { unlock = resolve; });
        const previous = this.opLock;
        this.opLock = previous.then(() => gate);

        try {
            await previous;
            return await operation();
        } finally {
            unlock();
        }
    }
}
