// SPDX-FileCopyrightText: 2025-2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS AtmoWEB gateway
Copyright (C) 2025-2026  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

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

import { EventEmitter } from "events";

/**
 * High‑level connection state.
 */
//export type ConnectionState = "disconnected" | "connecting" | "connected";
export enum ClientState { Disconnected, Connecting, Connected }

export class ClientEvent {
    static readonly state = "state"
    static readonly config = "config"
    static readonly data = "data"
    static readonly log = "log"
    static readonly error = "error"
}

/**
 * Options for a single simulator instance.
 */
export interface AtmoWebClientOptions {
    /** Base URL of the AtmoWEB REST API, e.g. "http://localhost:8081" */
    baseURL: string;
    /** Polling period for process variables (ms). Default: 2000 ms */
    pollInterval?: number;
    /** Polling period for Log.txt (ms). Default: 5000 ms */
    logInterval?: number;
    /** Retry delay after a failed connect (ms). Default: 5000 ms */
    retryDelay?: number;
}

/** Write request object pushed by the supervisory layer. */
export interface WriteRequest {
    param: string;
    value: string | number;
}

/**
 * AtmoWEB REST client that supports one simulator chamber.
 * Use as many instances as you have devices (multi‑device capable).
 *
 * The class is an `EventEmitter` and emits:
 *  • `state`   – `(state: ConnectionState)`
 *  • `config`  – `(snapshot: Record<string, unknown>)` full commands.cgi reply
 *  • `data`    – `(values: Record<string, unknown>)` periodic read values
 *  • `log`     – `(lines: string[])` new log lines
 *  • `error`   – `(err: unknown)` unexpected network/parse errors
 */
export class AtmoWebClient extends EventEmitter {
    /* ------------------------------------------------------------------ */
    readonly opts: Required<AtmoWebClientOptions>;
    private state: ClientState = ClientState.Disconnected;

    private pollTimer?: NodeJS.Timeout;
    private logTimer?: NodeJS.Timeout;

    private variables: string[] = [];
    private writeQueue: WriteRequest[] = [];
    private lastLogLines = 0;

    /* ------------------------------------------------------------------ */
    constructor(opts: AtmoWebClientOptions) {
        super();
        this.opts = {
            pollInterval: 2000,
            logInterval: 5000,
            retryDelay: 5000,
            ...opts,
        } as Required<AtmoWebClientOptions>;

        /* immediate connect attempt */
        this.connect();
    }

    /* ------------------------------------------------------------------ */
    /** The supervisory layer may (re)define which variables to poll. */
    public setVariables(vars: string[]): void {
        this.variables = [...new Set(vars)]; // dedupe for good measure
    }

    /** Queue a write request (supervisor → REST). */
    public queueWrite(param: string, value: string | number): void {
        this.writeQueue.push({ param, value });
    }

    /** Current connection state getter. */
    public getState(): ClientState { return this.state; }

    /** Stop all polling and close the client. */
    public close(): void {
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.logTimer) clearInterval(this.logTimer);
        this.state = ClientState.Disconnected
        this.emit(ClientEvent.state, this.state);
    }

    /* ------------------------------------------------------------------ */
    /* ───────── internal: connect / reconnect handling ───────────────── */
    private async connect(): Promise<void> {
        if (this.state !== ClientState.Disconnected) return;
        this.state = ClientState.Connecting;
        this.emit(ClientEvent.state, this.state);

        try {
            console.log(`Try to connect to ${this.opts.baseURL} ..`)
            const snapshot = await this.fetchJSON("/commands.cgi");
            this.emit(ClientEvent.config, snapshot);

            console.log(`Connected to ${this.opts.baseURL} ..`)
            this.state = ClientState.Connected
            this.emit(ClientEvent.state, this.state);

            /* supervisor can now decide which vars to poll via setVariables() */
            this.startLoops();
        } catch (err) {
            this.emit(ClientEvent.error, err);
            this.state = ClientState.Disconnected;
            this.emit(ClientEvent.state, this.state);
            setTimeout(() => this.connect(), this.opts.retryDelay);
        }
    }

    /* ------------------------------------------------------------------ */
    private startLoops(): void {
        this.pollTimer = setInterval(() => this.pollVariables(), this.opts.pollInterval);
        this.logTimer = setInterval(() => this.pollLog(), this.opts.logInterval);
    }

    /* -- variable polling & writing ------------------------------------ */
    private async pollVariables(): Promise<void> {
        if (this.state !== ClientState.Connected || (!this.variables.length && !this.writeQueue.length)) return;

        const params = new URLSearchParams();

        /* reads */
        for (const v of this.variables) params.append(v, "");

        /* queued writes */
        for (const w of this.writeQueue) params.set(w.param, String(w.value));
        this.writeQueue.length = 0;

        try {
            console.log(`Fetch data from ${this.opts.baseURL} "${params}"`)
            const data = await this.fetchJSON("/atmoweb?" + params.toString());
            if (data) {
                this.emit(ClientEvent.data, data);
            }
        } catch (err) {
            this.emit(ClientEvent.error, err);
        }
    }

    /* -- log polling ---------------------------------------------------- */
    private async pollLog(): Promise<void> {
        if (this.state !== ClientState.Connected) return;

        try {
            const txt = await this.fetchText("/Controller/Config/Log.txt");
            if (txt) {
                const lines = txt.split("\n");
                const fresh = lines.slice(this.lastLogLines);
                if (fresh.length) {
                    this.emit(ClientEvent.log, fresh);
                }
                this.lastLogLines = lines.length;
            }
        } catch (err) {
            this.emit(ClientEvent.error, err);
        }
    }

    /* ------------------------------------------------------------------ */
    private async fetchJSON(path: string): Promise<any> {

        async function parseResponse(response: Response): Promise<any> {
            const text = (await response.text()).trim()
            const isJsonObject = text.startsWith("{") && text.endsWith("}")
            if (isJsonObject) {
                return JSON.parse(text)
            }
            // Real server: missing braces + trailing comma
            return JSON.parse(`{${text.replace(/,\s*$/, "")}}`)
        }

        try {
            const res = await fetch(this.opts.baseURL + path, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) throw new Error(`HTTP ${res.status} – ${path}`);
            const data = parseResponse(res)
            return data

        } catch (err) {
            this.emit(ClientEvent.error, err);
        }
    }

    private async fetchText(path: string): Promise<string> {
        try {
            const res = await fetch(this.opts.baseURL + path, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) throw new Error(`HTTP ${res.status} – ${path}`);
            return await res.text();
        } catch (err) {
            this.emit(ClientEvent.error, err);
        }
    }
}

