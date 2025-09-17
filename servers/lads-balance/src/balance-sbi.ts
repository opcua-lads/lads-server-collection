import { SerialBalance } from "./balance-serial";
import { BalanceReading, toGrams, DeviceInfo, BalanceResponseType } from "./balance";

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
export class SbiBalance extends SerialBalance {

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
/*"2025-09-17     09:10
Internal calibration
Start: manually     
Dev         0.00 g  
Internal adjustment 
Dev         0.00 g 
*/

    async getCurrentReading(): Promise<BalanceReading> {
        const response = await this.sendEsc("P");
        const l = response.length
        if (l === 22) {
            const marker = response.slice(0, 6).trim()
            const sign = response.slice(6,7)
            const value = response.slice(7, 16).trim()
            const unit = response.slice(17, 20).trim()
            const isTared = marker === "N"        // 'N' = net (tared), 'G' = gross (not tared)
            const stable = unit.length > 0
            const weight = toGrams(Number(sign + value), unit || "g")
            const s = value.toLowerCase()
            const responseType = (s === "high")?BalanceResponseType.High:(s === "low")?BalanceResponseType.Low:BalanceResponseType.Reading
            return { weight, unit, stable, isTared, responseType, response: response}
        } else if ((l > 22) && (response.toLowerCase().includes("calibration"))) {
            this.calibrationTimestamp =  new Date(response.split(/\r\n/, 1)[0].replace(/\s+/, ' '))
            this.calibrationReport = response
            return { weight: 0, unit: "g", stable: false, isTared: false, responseType: BalanceResponseType.Calibration, response: response}
        } else {
            return undefined
        }
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