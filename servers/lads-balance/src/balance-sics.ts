import { SerialBalance } from "./balance-serial";
import { BalanceReading, toGrams, DeviceInfo } from "./balance";

/**
 * Driver for Mettler Toledo balances using the MT-SICS protocol.
 *
 * Key commands used:
 *   - SI  : Send immediate weight (stable/unstable, net)
 *   - TA  : Query current tare value (for isTared and optional tare amount)
 *   - T   : Set current gross as tare
 *   - Z   : Zero the balance
 *   - I2  : Model/type and capacity
 *   - I3  : Software version and type definition
 *   - I4  : Serial number
 *   - I10 : User-defined device ID (optional)
 */
export class SicsBalance extends SerialBalance {
  /**
   * Query current weight and tare status.
   * Polls SI for weight and TA for tare info.
   */
  async getCurrentReading(): Promise<BalanceReading> {
    // 1️⃣ Current weight (and stable/unstable) from SI
    const siResp = await this.sendCommand("SI");
    // Examples:
    //   S      +12.345 g   (stable)
    //   D      +12.345 g   (unstable)
    const m = siResp.match(/(S|D)\s+([+-]?\d+(\.\d+)?)\s*(\w+)/);
    if (!m) throw new Error(`Invalid SICS SI response: ${siResp}`);

    const stable = m[1] === "S";
    const unit = m[4];
    const weight = toGrams(parseFloat(m[2]), unit);

    // 2️⃣ Current tare value from TA (to determine if tared)
    let isTared = false;
    try {
      const taResp = await this.sendCommand("TA");
      // Examples:
      //   TA      +1.234 g   (tared)
      //   TA      +0.000 g   (not tared)
      const tMatch = taResp.match(/TA\s+([+-]?\d+(\.\d+)?)\s*(\w+)/);
      if (tMatch) {
        const tareGrams = toGrams(parseFloat(tMatch[1]), tMatch[2]);
        isTared = Math.abs(tareGrams) > 1e-6; // treat ~0 g as not tared
      }
    } catch {
      // If TA not supported or fails, just leave isTared false
    }

    return {
      weight,
      unit,
      stable,
      isTared,
    };
  }

  /**
   * Set current gross as tare.
   */
  async tare(): Promise<void> {
    await this.sendCommand("T");
  }

  /**
   * Zero the balance explicitly.
   */
  async zero(): Promise<void> {
    await this.sendCommand("Z");
  }

  /**
   * Retrieve device identification and firmware info.
   * According to MT-SICS specification:
   *   I2  -> Model/type and capacity
   *   I3  -> Software version and type definition
   *   I4  -> Serial number
   *   I10 -> User-defined device ID (optional)
   */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const info: DeviceInfo = {
      manufacturer: "Mettler Toledo",
      model: "Unknown",
    };

    try {
      const respI2 = await this.sendCommand("I2");
      const m = respI2.match(/I2\s+(.+)/);
      if (m) info.model = m[1].trim();
    } catch {}

    try {
      const respI3 = await this.sendCommand("I3");
      const v = respI3.match(/I3\s+(.+)/);
      if (v) info.firmware = v[1].trim();
    } catch {}

    try {
      const respI4 = await this.sendCommand("I4");
      const s = respI4.match(/I4\s+(.+)/);
      if (s) info.serialNumber = s[1].trim();
    } catch {}

    return info;
  }
}
