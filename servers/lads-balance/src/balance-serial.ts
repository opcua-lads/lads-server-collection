import { SerialPort } from "serialport";
import { Balance, BalanceStatus, BalanceEvents } from "./balance";

/**
 * Base class for balances communicating over a serial port.
 * Handles connect/disconnect, background polling and event emission.
 * Protocol-specific subclasses only need to implement:
 *   - getCurrentReading()
 *   - tare()
 *   - zero()
 *   - getDeviceInfo() (optional)
 */
export abstract class SerialBalance extends Balance {
    protected port: SerialPort;
    protected buffer = "";
    private polling?: NodeJS.Timeout;
    private statusCheck?: NodeJS.Timeout;
    private lastStatus?: BalanceStatus;

    constructor(id: string, portPath: string, baudRate = 9600) {
        super(id);
        this.port = new SerialPort({ path: portPath, baudRate });
    }

    /**
     * Opens the serial port and starts status monitoring.
     * Emits an initial DeviceInfo (if supported) and an initial Reading.
     */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.port.on("open", async () => {
                try {
                    if (this.getDeviceInfo) {
                        const info = await this.getDeviceInfo();
                        if (info) this.emitter.emit(BalanceEvents.DeviceInfo, info);
                    }

                    this.startStatusMonitor();

                    // Send one initial reading so callers get immediate data.
                    try {
                        const reading = await this.getCurrentReading();
                        this.emitter.emit(BalanceEvents.Reading, reading);
                    } catch (e) {
                        this.emitter.emit(BalanceEvents.Error, e);
                    }
                } finally {
                    resolve();
                }
            });

            this.port.on("error", reject);
            this.port.on("data", (d: Buffer) => {
                this.buffer += d.toString("utf-8");
            });
        });
    }

    /**
     * Closes the port and stops background tasks.
     */
    async disconnect(): Promise<void> {
        if (this.polling) clearInterval(this.polling);
        if (this.statusCheck) clearInterval(this.statusCheck);
        this.port.close();
    }

    /**
     * Returns Online if the serial port is open, otherwise Offline.
     */
    async getStatus(): Promise<BalanceStatus> {
        return this.port.isOpen ? BalanceStatus.Online : BalanceStatus.Offline;
    }

    /**
     * Sends a command terminated with CRLF and waits a short time
     * for the balance to reply, returning the trimmed response string.
     */
    protected async sendCommand(cmd: string, waitMs = 200): Promise<string> {
        this.buffer = "";
        this.port.write(cmd + "\r\n");
        await new Promise(res => setTimeout(res, waitMs));
        return this.buffer.trim();
    }

    /**
     * Start automatic polling of weight readings at the given interval.
     * Emits BalanceEvents.Reading for every successful reading.
     */
    startPolling(intervalMs = 1000): void {
        if (this.polling) clearInterval(this.polling);
        this.polling = setInterval(async () => {
            try {
                const r = await this.getCurrentReading();
                this.emitter.emit(BalanceEvents.Reading, r);
            } catch (e) {
                this.emitter.emit(BalanceEvents.Error, e);
            }
        }, intervalMs);
    }

    /**
     * Internal: periodically checks the serial port state and emits
     * BalanceEvents.Status when it changes.
     */
    private startStatusMonitor(intervalMs = 2000): void {
        if (this.statusCheck) clearInterval(this.statusCheck);
        this.statusCheck = setInterval(async () => {
            const s = await this.getStatus();
            if (s !== this.lastStatus) {
                this.lastStatus = s;
                this.emitter.emit(BalanceEvents.Status, s);
            }
        }, intervalMs);
    }

}
