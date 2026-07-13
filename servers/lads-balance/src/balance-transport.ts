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

import { EventEmitter } from "node:events";
import net, { type TcpNetConnectOpts, type Socket } from "node:net";
import { statSync } from "node:fs";
import { SerialPort } from "serialport";

export type SerialBalanceTransportOptions =
    ConstructorParameters<typeof SerialPort>[0];

//---------------------------------------------------------------
// General byte-stream transport used by protocol drivers. 
//---------------------------------------------------------------
export type TransportEvents = {
    open: [];
    close: [hadError?: boolean];
    data: [data: Buffer];
    error: [error: Error];
};

export abstract class BalanceTransport extends EventEmitter {
    abstract get isOpen(): boolean;
    abstract open(): Promise<void>;
    abstract close(): Promise<void>;
    abstract write(data: string | Buffer): Promise<void>;

    override on<K extends keyof TransportEvents>(
        event: K,
        listener: (...args: TransportEvents[K]) => void,
    ): this {
        return super.on(event, listener);
    }

    override once<K extends keyof TransportEvents>(
        event: K,
        listener: (...args: TransportEvents[K]) => void,
    ): this {
        return super.once(event, listener);
    }

    protected emitTyped<K extends keyof TransportEvents>(
        event: K,
        ...args: TransportEvents[K]
    ): boolean {
        return super.emit(event, ...args);
    }
}

//---------------------------------------------------------------
// Serial port
//---------------------------------------------------------------
export class SerialBalanceTransport extends BalanceTransport {
    private port?: SerialPort;

    public constructor(
        private readonly options: SerialBalanceTransportOptions,
    ) {
        super();
    }

    public get isOpen(): boolean {
        return this.port?.isOpen ?? false;
    }

    public static isAvailable(path: string): boolean {
        try {
            return statSync(path).isCharacterDevice();
        } catch {
            return false;
        }
    }

    public async open(): Promise<void> {
        if (this.isOpen) return;

        if (!SerialBalanceTransport.isAvailable(this.options.path)) {
            throw new Error(`Serial port ${this.options.path} is not available`);
        }

        if (!this.port) {
            this.port = new SerialPort({
                ...this.options,
                autoOpen: false,
            });

            this.port.on("data", (data: Buffer) => this.emitTyped("data", data));
            this.port.on("error", (error: Error) => this.emitTyped("error", error));
            this.port.on("close", () => this.emitTyped("close", false));
        }

        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                this.port?.off("open", onOpen);
                reject(error);
            };
            const onOpen = (): void => {
                this.port?.off("error", onError);
                this.emitTyped("open");
                resolve();
            };

            this.port!.once("error", onError);
            this.port!.once("open", onOpen);
            this.port!.open();
        });
    }

    public async close(): Promise<void> {
        if (!this.port?.isOpen) return;

        await new Promise<void>((resolve, reject) => {
            this.port!.close(error => error ? reject(error) : resolve());
        });
    }

    public async write(data: string | Buffer): Promise<void> {
        if (!this.port?.isOpen) {
            throw new Error("Serial transport is not open");
        }

        await new Promise<void>((resolve, reject) => {
            this.port!.write(data, error => {
                if (error) {
                    reject(error);
                    return;
                }
                this.port!.drain(drainError => drainError ? reject(drainError) : resolve());
            });
        });
    }
}

//---------------------------------------------------------------
// TCP
//---------------------------------------------------------------
export type TcpBalanceTransportOptions = TcpNetConnectOpts & {
    keepAlive?: boolean;
    keepAliveInitialDelay?: number;
    noDelay?: boolean;
};

export class TcpBalanceTransport extends BalanceTransport {
    private socket?: Socket;

    public constructor(
        private readonly options: TcpBalanceTransportOptions,
    ) {
        super();
    }

    public get isOpen(): boolean {
        return Boolean(this.socket && !this.socket.destroyed && this.socket.readyState === "open");
    }

    public async open(): Promise<void> {
        if (this.isOpen) return;

        // net.Socket instances cannot be reliably reused after destruction.
        const socket = net.createConnection(this.options);
        this.socket = socket;

        socket.setNoDelay(this.options.noDelay ?? true);
        socket.setKeepAlive(
            this.options.keepAlive ?? true,
            this.options.keepAliveInitialDelay ?? 10_000,
        );

        socket.on("data", data => this.emitTyped("data", data));
        socket.on("error", error => this.emitTyped("error", error));
        socket.on("close", hadError => this.emitTyped("close", hadError));

        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                socket.off("connect", onConnect);
                reject(error);
            };
            const onConnect = (): void => {
                socket.off("error", onError);
                this.emitTyped("open");
                resolve();
            };

            socket.once("error", onError);
            socket.once("connect", onConnect);
        });
    }

    public async close(): Promise<void> {
        const socket = this.socket;
        if (!socket || socket.destroyed) return;

        await new Promise<void>(resolve => {
            socket.once("close", () => resolve());
            socket.end();
        });
    }

    public async write(data: string | Buffer): Promise<void> {
        if (!this.isOpen || !this.socket) {
            throw new Error("TCP transport is not open");
        }

        await new Promise<void>((resolve, reject) => {
            this.socket!.write(data, error => error ? reject(error) : resolve());
        });
    }
}