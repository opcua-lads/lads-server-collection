import { SerialBalance } from "./balance-serial"
import { BalanceReading, BalanceTareMode, DeviceInfo, toGrams } from "./balance"

/**
 * KERN KCP driver (skeleton).
 *
 * KCP is ASCII (CRLF), case-sensitive.
 * Common commands (see KCP manual):
 *   S    : send stable value (only replies when stable)
 *   SI   : send immediate value (stable or not)
 *   SIR  : send immediate value and repeat (autoprint stream)
 *   T    : tare
 *   Z    : zero
 *   I0   : list implemented commands
 *   I1   : KCP level/version
 *   I2   : device/model data (model, capacity etc.)
 *   I3   : software version
 *   I4   : serial number (often quoted)
 *
 * References: KCP-ZB manuals and model manuals. 
 * (Commands and availability vary by device/firmware.)
 */
export class KcpBalance extends SerialBalance {
    private readonly  pollCmd: "SI" | "S" = "SI"

    /**
     * Parse a KCP weight line.
     * KCP responses are fixed-width ASCII; many models include a stability flag.
     * We'll support two common shapes:
     *   1) Fixed-field layout containing a stability char ('S' stable / 'U' unstable).
     *   2) Simpler "value unit" when using S (stable-only).
     *
     * We try to detect a stability flag; if missing (e.g., using S), we set stable=true.
     */
    private parseKcpWeight(line: string): { weight: number; unit: string; stable: boolean } {
        const trimmed = line.trim();

        // Example patterns seen across KCP devices:

        // A) Explicit stability flag somewhere before the number (e.g., "... S  +123.45 g")
        let m = trimmed.match(/(^|[\s])([SU])[\s]+([+-]?\d+(?:\.\d+)?)[\s]*([a-zA-Zµu]+)$/);
        if (m) {
            const stable = m[2] === "S";
            const unit = m[4];
            const weight = toGrams(parseFloat(m[3]), unit);
            return { weight, unit, stable };
        }

        // B) Stable-only reply (command "S"): just number + unit
        m = trimmed.match(/^([+-]?\d+(?:\.\d+)?)\s*([a-zA-Zµu]+)$/);
        if (m) {
            const unit = m[2];
            const weight = toGrams(parseFloat(m[1]), unit);
            return { weight, unit, stable: true };
        }

        // C) Some instruments include prefixes or headers — fall back by finding last "<num unit>"
        m = trimmed.match(/([+-]?\d+(?:\.\d+)?)\s*([a-zA-Zµu]+)\s*$/);
        if (m) {
            const unit = m[2];
            const weight = toGrams(parseFloat(m[1]), unit);
            // If we couldn’t see a flag, treat SI as possibly unstable; S as stable.
            const stable = this.pollCmd === "S";
            return { weight, unit, stable };
        }

        throw new Error(`Unrecognized KCP weight format: "${line}"`);
        // Tip: enable a debug log to examine raw lines if this trips on a specific model.
    }

    /**
     * Poll current reading.
     * Uses the SerialBalance transaction queue via sendCommand(), so it won't
     * collide with tare/zero or other commands.
     */
    async getCurrentReading(): Promise<BalanceReading> {
        const resp = await this.sendCommand(this.pollCmd);
        const { weight, unit, stable } = this.parseKcpWeight(resp);

        // KCP does not universally expose a direct "is net" flag in the simple weight line.
        // Many models show NET/GROSS in continuous print headers, but the single read often lacks it.
        // KISS: we do not infer tare state here.
        const tareMode = BalanceTareMode.Manual

        return { weight, unit, stable, tareMode };
    }

    /**
     * Tare current load.
     * Serialized via sendCommand() (queue), so it does not conflict with polling.
     */
    async setTare(): Promise<void> {
        // Some models accept "T", others "t". KCP is case-sensitive; "T" is typical per KCP docs.
        await this.sendCommand("T");
    }

    /**
     * Zero the indication explicitly.
     * Serialized via sendCommand() (queue), so it does not conflict with polling.
     */
    async setZero(): Promise<void> {
        // Many KCP devices support "Z" (and sometimes "ZI" = immediate zero reset).
        // Prefer "Z"; if your model requires ZI, change here or add a feature flag.
        await this.sendCommand("Z");
    }

    /**
     * Query device info via I-commands (subset depends on the device).
     * We collect what we can and skip missing pieces gracefully.
     */
    async getDeviceInfo(): Promise<DeviceInfo> {
        const info: DeviceInfo = { manufacturer: "KERN", model: "Unknown" };

        const safe = async (cmd: string) => {
            try {
                const line = await this.sendCommand(cmd);
                // Many KCP replies look like: I2 A <payload>   or I4 A "xxxxxxxx"
                const m = line.match(/^[A-Za-z0-9]+(?:\s+[A-Z])?\s+(.*)$/);
                return m ? m[1].trim().replace(/^"|"$/g, "") : undefined;
            } catch {
                return undefined;
            }
        };

        // Commonly implemented (per KCP docs / model manuals):
        // I2: device/model data (type/capacity), I3: software version, I4: serial number.
        const model = await safe("I2"); if (model) info.model = model;
        const firmware = await safe("I3"); if (firmware) info.firmware = firmware;
        const serial = await safe("I4"); if (serial) info.serialNumber = serial;

        // Optional: KCP version/info
        const kcpVer = await safe("I1"); if (kcpVer) info.hardware = `KCP ${kcpVer}`;

        return info;
    }
}
