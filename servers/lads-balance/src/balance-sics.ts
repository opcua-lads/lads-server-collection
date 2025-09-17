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

import { SerialBalance } from "./balance-serial";
import { BalanceReading, toGrams, DeviceInfo } from "./balance";

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
