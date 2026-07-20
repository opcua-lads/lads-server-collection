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

import { EventEmitter } from "node:events";

/**
 * High-level connection state.
 */
export enum ClientState {
    Disconnected,
    Connecting,
    Connected,
}

/**
 * Events emitted by AtmoWebClient.
 */
export class ClientEvent {
    static readonly state = "state";
    static readonly config = "config";
    static readonly data = "data";
    static readonly log = "log";
    static readonly error = "error";
}

/**
 * Options for a single simulator instance.
 */
export interface AtmoWebClientOptions {
    /** Base URL of the AtmoWEB REST API, e.g. "http://localhost:8081". */
    baseURL: string;

    /** Polling period for process variables in milliseconds. Default: 2000. */
    pollInterval?: number;

    /** Polling period for Log.txt in milliseconds. Default: 5000. */
    logInterval?: number;

    /** Retry delay after a failed initial connection in milliseconds. Default: 5000. */
    retryDelay?: number;

    /** HTTP request timeout in milliseconds. Default: 5000. */
    requestTimeout?: number;
}

/**
 * Write request queued by the supervisory layer.
 */
export interface WriteRequest {
    param: string;
    value: string | number;
}

export type AtmoWebSnapshot = Record<string, unknown>;
export type AtmoWebValues = Record<string, unknown>;

/**
 * Error returned for non-successful HTTP responses.
 */
export class AtmoWebHttpError extends Error {
    public readonly status: number;
    public readonly statusText: string;
    public readonly path: string;

    constructor(response: Response, path: string) {
        super(
            `HTTP ${response.status} ${response.statusText || "Unknown Error"} – ${path}`,
        );

        this.name = "AtmoWebHttpError";
        this.status = response.status;
        this.statusText = response.statusText;
        this.path = path;
    }
}

/**
 * Error returned when an HTTP request times out.
 */
export class AtmoWebTimeoutError extends Error {
    public readonly path: string;
    public readonly timeout: number;

    constructor(path: string, timeout: number) {
        super(`Request timed out after ${timeout} ms – ${path}`);

        this.name = "AtmoWebTimeoutError";
        this.path = path;
        this.timeout = timeout;
    }
}

/**
 * AtmoWEB REST client for one simulator chamber.
 *
 * Create one instance per device.
 *
 * Events:
 *
 * - `state`  – `(state: ClientState)`
 * - `config` – `(snapshot: AtmoWebSnapshot)`
 * - `data`   – `(values: AtmoWebValues)`
 * - `log`    – `(lines: string[])`
 * - `error`  – `(error: unknown)`
 *
 * The client does not automatically start from its constructor. Call
 * `await client.start()` after attaching event listeners.
 */
export class AtmoWebClient extends EventEmitter {
    public readonly opts: Required<AtmoWebClientOptions>;

    private state = ClientState.Disconnected;
    private closed = true;

    private pollTimer?: NodeJS.Timeout;
    private logTimer?: NodeJS.Timeout;
    private reconnectTimer?: NodeJS.Timeout;

    private variables: string[] = [];
    private writeQueue: WriteRequest[] = [];

    private lastLogLines = 0;

    /**
     * All active request controllers are tracked so close() can cancel them.
     */
    private readonly activeRequests = new Set<AbortController>();

    constructor(opts: AtmoWebClientOptions) {
        super();

        if (!opts.baseURL.trim()) {
            throw new Error("AtmoWebClient requires a non-empty baseURL");
        }

        this.opts = {
            baseURL: opts.baseURL.replace(/\/+$/, ""),
            pollInterval: opts.pollInterval ?? 2000,
            logInterval: opts.logInterval ?? 5000,
            retryDelay: opts.retryDelay ?? 5000,
            requestTimeout: opts.requestTimeout ?? 5000,
        };

        this.validateOptions();
    }

    /**
     * Start the client and perform an immediate connection attempt.
     *
     * If the first connection attempt fails, an error event is emitted and
     * reconnection is scheduled automatically.
     */
    public async start(): Promise<void> {
        if (!this.closed) {
            return;
        }

        this.closed = false;
        await this.connect();
    }

    /**
     * Define which variables should be included in each polling request.
     */
    public setVariables(variables: string[]): void {
        this.variables = [
            ...new Set(
                variables
                    .map((variable) => variable.trim())
                    .filter(Boolean),
            ),
        ];
    }

    /**
     * Queue a write operation.
     *
     * Writes are removed from the queue only after a successful HTTP request.
     * Failed batches are restored to the front of the queue.
     */
    public queueWrite(param: string, value: string | number): void {
        const normalizedParam = param.trim();

        if (!normalizedParam) {
            throw new Error("Write parameter must not be empty");
        }

        this.writeQueue.push({
            param: normalizedParam,
            value,
        });
    }

    /**
     * Return the current connection state.
     */
    public getState(): ClientState {
        return this.state;
    }

    /**
     * Stop polling, cancel reconnect attempts, and abort active requests.
     *
     * The same instance may be restarted later by calling start().
     */
    public close(): void {
        if (this.closed) {
            return;
        }

        this.closed = true;

        this.clearTimers();
        this.abortActiveRequests();

        this.setState(ClientState.Disconnected);
    }

    /**
     * Clear the remembered log position.
     *
     * This causes the next log poll to emit the full current log.
     */
    public resetLogPosition(): void {
        this.lastLogLines = 0;
    }

    /**
     * Return the number of currently queued writes.
     */
    public getPendingWriteCount(): number {
        return this.writeQueue.length;
    }

    /* ------------------------------------------------------------------ */
    /* Connection lifecycle                                               */
    /* ------------------------------------------------------------------ */

    private async connect(): Promise<void> {
        if (this.closed || this.state !== ClientState.Disconnected) {
            return;
        }

        this.clearReconnectTimer();
        this.setState(ClientState.Connecting);

        try {
            const snapshot =
                await this.fetchJSON<AtmoWebSnapshot>("commands.cgi");

            /*
             * close() may have been called while the request was completing.
             */
            if (this.closed) {
                return;
            }

            this.emit(ClientEvent.config, snapshot);
            this.setState(ClientState.Connected);

            this.startPollingLoops();
        } catch (error) {
            if (this.closed || this.isClientCloseAbort(error)) {
                return;
            }

            this.setState(ClientState.Disconnected);
            this.emit(ClientEvent.error, error);
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (this.closed || this.reconnectTimer) {
            return;
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.connect();
        }, this.opts.retryDelay);
    }

    private setState(nextState: ClientState): void {
        if (this.state === nextState) {
            return;
        }

        this.state = nextState;
        this.emit(ClientEvent.state, nextState);
    }

    /* ------------------------------------------------------------------ */
    /* Polling lifecycle                                                  */
    /* ------------------------------------------------------------------ */

    private startPollingLoops(): void {
        this.clearPollingTimers();

        this.scheduleVariablePoll(this.opts.pollInterval);
        this.scheduleLogPoll(this.opts.logInterval);
    }

    /**
     * Recursive setTimeout is used instead of setInterval.
     *
     * This ensures the next poll is not started until the current asynchronous
     * poll has completed, preventing overlapping requests.
     */
    private scheduleVariablePoll(delay: number): void {
        if (this.closed || this.state !== ClientState.Connected) {
            return;
        }

        this.pollTimer = setTimeout(() => {
            this.pollTimer = undefined;
            void this.runVariablePoll();
        }, delay);
    }

    private async runVariablePoll(): Promise<void> {
        if (this.closed || this.state !== ClientState.Connected) {
            return;
        }

        try {
            await this.pollVariables();
        } finally {
            this.scheduleVariablePoll(this.opts.pollInterval);
        }
    }

    private scheduleLogPoll(delay: number): void {
        if (this.closed || this.state !== ClientState.Connected) {
            return;
        }

        this.logTimer = setTimeout(() => {
            this.logTimer = undefined;
            void this.runLogPoll();
        }, delay);
    }

    private async runLogPoll(): Promise<void> {
        if (this.closed || this.state !== ClientState.Connected) {
            return;
        }

        try {
            await this.pollLog();
        } finally {
            this.scheduleLogPoll(this.opts.logInterval);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Variable polling and writing                                       */
    /* ------------------------------------------------------------------ */

    private async pollVariables(): Promise<void> {
        if (
            this.state !== ClientState.Connected ||
            (!this.variables.length && !this.writeQueue.length)
        ) {
            return;
        }

        const params = new URLSearchParams();

        /*
         * Capture the current variables so setVariables() calls during the
         * request do not mutate the request being constructed.
         */
        const variables = [...this.variables];

        for (const variable of variables) {
            params.append(variable, "");
        }

        /*
         * Remove this batch from the live queue while it is in flight.
         * Writes queued during the request remain in this.writeQueue.
         */
        const writes = this.writeQueue.splice(0);

        for (const write of writes) {
            /*
             * URLSearchParams.set() means the latest write for a parameter
             * within this batch wins.
             */
            params.set(write.param, String(write.value));
        }

        try {
            const values = await this.fetchJSON<AtmoWebValues>(
                `atmoweb?${params.toString()}`,
            );

            if (!this.closed && this.state === ClientState.Connected) {
                this.emit(ClientEvent.data, values);
            }
        } catch (error) {
            /*
             * Restore failed writes before writes that were queued while this
             * request was in flight.
             *
             * On the next request, newer writes appear later and therefore win
             * when URLSearchParams.set() is called.
             */
            this.writeQueue = writes.concat(this.writeQueue);

            if (!this.closed && !this.isClientCloseAbort(error)) {
                this.emit(ClientEvent.error, error);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Log polling                                                        */
    /* ------------------------------------------------------------------ */

    private async pollLog(): Promise<void> {
        if (this.state !== ClientState.Connected) {
            return;
        }

        try {
            const text = await this.fetchText(
                "Controller/Config/Log.txt",
            );

            if (this.closed || this.state !== ClientState.Connected) {
                return;
            }

            const lines = this.splitLogLines(text);

            /*
             * If the log became shorter, assume it was truncated or rotated
             * and emit the new file from the beginning.
             */
            const logWasReset = lines.length < this.lastLogLines;
            const startIndex = logWasReset ? 0 : this.lastLogLines;
            const freshLines = lines.slice(startIndex);

            if (freshLines.length > 0) {
                this.emit(ClientEvent.log, freshLines);
            }

            this.lastLogLines = lines.length;
        } catch (error) {
            if (!this.closed && !this.isClientCloseAbort(error)) {
                this.emit(ClientEvent.error, error);
            }
        }
    }

    private splitLogLines(text: string): string[] {
        if (!text) {
            return [];
        }

        const lines = text.split(/\r?\n/);

        /*
         * A final newline creates an artificial empty line. Removing it avoids
         * repeatedly counting it as a real log record.
         */
        if (lines.at(-1) === "") {
            lines.pop();
        }

        return lines;
    }

    /* ------------------------------------------------------------------ */
    /* HTTP helpers                                                       */
    /* ------------------------------------------------------------------ */

    private async fetchJSON<T>(path: string): Promise<T> {
        const response = await this.fetchResponse(path);
        return response.json() as Promise<T>;
    }

    private async fetchText(path: string): Promise<string> {
        const response = await this.fetchResponse(path);
        return response.text();
    }

    private async fetchResponse(path: string): Promise<Response> {
        if (this.closed) {
            throw this.createClientCloseAbort();
        }

        const controller = new AbortController();
        this.activeRequests.add(controller);

        const timeout = setTimeout(() => {
            controller.abort(
                new AtmoWebTimeoutError(path, this.opts.requestTimeout),
            );
        }, this.opts.requestTimeout);

        try {
            const response = await fetch(this.buildURL(path), {
                method: "GET",
                signal: controller.signal,
                headers: {
                    accept: "*/*",
                },
            });

            if (!response.ok) {
                throw new AtmoWebHttpError(response, path);
            }

            return response;
        } catch (error) {
            /*
             * Modern Node fetch generally propagates AbortController.reason.
             * This fallback keeps timeout and close errors meaningful on
             * runtimes that instead return a generic AbortError.
             */
            if (controller.signal.aborted) {
                throw controller.signal.reason ?? error;
            }

            throw error;
        } finally {
            clearTimeout(timeout);
            this.activeRequests.delete(controller);
        }
    }

    private buildURL(path: string): URL {
        const normalizedPath = path.replace(/^\/+/, "");
        return new URL(normalizedPath, `${this.opts.baseURL}/`);
    }

    /* ------------------------------------------------------------------ */
    /* Cleanup                                                            */
    /* ------------------------------------------------------------------ */

    private clearTimers(): void {
        this.clearPollingTimers();
        this.clearReconnectTimer();
    }

    private clearPollingTimers(): void {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }

        if (this.logTimer) {
            clearTimeout(this.logTimer);
            this.logTimer = undefined;
        }
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    private abortActiveRequests(): void {
        const closeError = this.createClientCloseAbort();

        for (const controller of this.activeRequests) {
            controller.abort(closeError);
        }

        this.activeRequests.clear();
    }

    private createClientCloseAbort(): Error {
        const error = new Error("AtmoWebClient was closed");
        error.name = "AbortError";
        return error;
    }

    private isClientCloseAbort(error: unknown): boolean {
        return (
            this.closed &&
            error instanceof Error &&
            error.name === "AbortError"
        );
    }

    private validateOptions(): void {
        this.assertPositiveNumber(
            "pollInterval",
            this.opts.pollInterval,
        );
        this.assertPositiveNumber(
            "logInterval",
            this.opts.logInterval,
        );
        this.assertPositiveNumber(
            "retryDelay",
            this.opts.retryDelay,
        );
        this.assertPositiveNumber(
            "requestTimeout",
            this.opts.requestTimeout,
        );

        try {
            new URL(this.opts.baseURL);
        } catch {
            throw new Error(
                `Invalid AtmoWEB base URL: ${this.opts.baseURL}`,
            );
        }
    }

    private assertPositiveNumber(name: string, value: number): void {
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error(`${name} must be a positive finite number`);
        }
    }
}

async function test() {
    const client = new AtmoWebClient({
        baseURL: "http://localhost:8081",
    });

    client.on(ClientEvent.state, (state: ClientState) => {
        console.log("State:", ClientState[state]);
    });

    client.on(ClientEvent.config, (config: AtmoWebSnapshot) => {
        console.log("Config:", config);

        client.setVariables([
            "temperature",
            "humidity",
        ]);
    });

    client.on(ClientEvent.data, (values: AtmoWebValues) => {
        console.log("Values:", values);
    });

    client.on(ClientEvent.log, (lines: string[]) => {
        console.log("New log lines:", lines);
    });

    /*
     * EventEmitter treats "error" specially. Always attach this listener before
     * calling start(), otherwise emitting an error can terminate the process.
     */
    client.on(ClientEvent.error, (error: unknown) => {
        console.error("AtmoWEB error:", error);
    });

    await client.start();

    // Later:
    // client.queueWrite("setpoint", 22.5);
    // client.close();    
}