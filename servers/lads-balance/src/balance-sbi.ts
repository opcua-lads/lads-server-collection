import { SerialBalance } from "./balance-serial";
import { BalanceReading, toGrams, DeviceInfo } from "./balance";

/**
 * Driver for Sartorius balances using the PC-SBI protocol (ESC-based),
 * e.g. Quintix, Secura, Practum.
 * 
 * Provides:
 *   - getCurrentReading():   ESC P
 *   - tare():               ESC U
 *   - zero():               ESC V
 *   - getDeviceInfo():      ESC x1_, x2_, x3_, x4_
 *
 * Weight readings are always returned in grams.
 */
export class SbcBalance extends SerialBalance {

    /**
     * Send a PC-SBI command with ESC prefix and CR/LF termination.
     */
    protected async sendEsc(cmd: string, waitMs = 200): Promise<string> {
        return this.sendCommand(`\x1b${cmd}`, waitMs);
    }

    /**
     * Request the current reading.
     * Examples of PC-SBI responses to ESC P:
     *   "G   +123.456 g"   (stable gross)
     *   "N   +23.456"      (unstable net, unit missing)
     */
    async getCurrentReading(): Promise<BalanceReading> {
        const resp = await this.sendEsc("P");

        // Match: G/N, value, optional unit
        const m = resp.match(/^([GN])\s*([+-]?\d+(\.\d+)?)(?:\s*(\w+))?$/);
        if (!m) throw new Error(`Invalid PC-SBI response: ${resp}`);

        const isTared = m[1] === "N";        // 'N' = net (tared), 'G' = gross (not tared)
        const stable = !!m[4];              // stable if unit present
        const unit = m[4] || "g";         // assume g if no unit (unstable reading)
        const weight = toGrams(parseFloat(m[2]), unit);

        return { weight, unit, stable, isTared };
    }

    /**
     * Set current gross as tare (subtract current load).
     */
    async tare(): Promise<void> {
        await this.sendEsc("U");
    }

    /**
     * Zero the balance explicitly (supported on most Sartorius models).
     */
    async zero(): Promise<void> {
        await this.sendEsc("V");
    }

    /**
     * Retrieve device information.
     *   x1_ : model/type
     *   x2_ : serial number
     *   x3_ : firmware/software version
     *   x4_ : hardware or additional identifier
     */
    async getDeviceInfo(): Promise<DeviceInfo> {
        const info: DeviceInfo = { manufacturer: "Sartorius", model: "Unknown" };

        try {
            const m = await this.sendEsc("x1_");
            info.model = m.replace(/"/g, "").trim();
        } catch { }

        try {
            const s = await this.sendEsc("x2_");
            info.serialNumber = s.replace(/"/g, "").trim();
        } catch { }

        try {
            const f = await this.sendEsc("x3_");
            info.firmware = f.replace(/"/g, "").trim();
        } catch { }

        try {
            const h = await this.sendEsc("x4_");
            info.hardware = h.replace(/"/g, "").trim();
        } catch { }

        return info;
    }
}