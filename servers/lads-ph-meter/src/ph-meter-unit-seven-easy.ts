// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS pH-Meter
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

import { EventEmitter } from 'events';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import { setNumericValue } from '@utils'
import { pHMeterFunctionalUnit } from './ph-meter-interfaces';
import { pHMeterDeviceImpl } from './ph-meter-device';
import { pHMeterUnitImpl } from './ph-meter-unit';

//---------------------------------------------------------------
export class pHMeterSevenEasyUnitImpl extends pHMeterUnitImpl {

    constructor(parent: pHMeterDeviceImpl, functionalUnit: pHMeterFunctionalUnit, serialPort: string) {
        super(parent, functionalUnit)
        const parser = SerialPhMeterParser.attach(serialPort, 1000)

        parser.on('reading', ({ timestamp, pH, mV, temperature }) => {
            if (pH) {
                setNumericValue(this.pHSensor.sensorValue, pH)
            }
            if (mV) {
                setNumericValue(this.pHSensor.rawValue, mV)
            }
            if (temperature) {
                setNumericValue(this.pHSensor.compensationValue, temperature)
                setNumericValue(this.temperatureSensor.sensorValue, temperature)    
                this.currentRunOptions?.recorder?.createRecord()
            }
        })
    }

    get simulationMode(): boolean { return false }
}

//---------------------------------------------------------------
/* SerialPhMeterParser.ts
 * Parses the CR LF‑terminated output of a 1200 N81 pH/ORP meter and
 * automatically re‑triggers a new “read\r\n” cycle if the device
 * falls silent for more than `gapMillis` milliseconds (default 1000 ms).
 */

interface Reading {
    timestamp: Date;
    pH?: number;
    mV?: number;
    temperature?: number;
}

/**
 * Incremental parser.  Feed it complete *lines* (without CR LF) and it
 * emits a `reading` event whenever a measurement line is decoded.
 */
class SerialPhMeterParser extends EventEmitter {
    /**
     * Parse a single *complete* line coming from the meter.
     * The line **MUST NOT** contain CR or LF characters.
     */
    feed(line: string): void {
        if (!line) return;

        const reading: Reading = { timestamp: new Date() }
        const l = line.split(/\s+/).map(s => s.trim())
        l.forEach(s => {
            const value = parseFloat(s.slice(0, -2))
            if (!Number.isNaN(value)) {
                if (s.includes("pH")) {
                    reading.pH = value
                } else if (s.includes("mV")) {
                    reading.mV = value
                } else if (s.includes("C")) {
                    reading.temperature = value
                }
            }
        })
        // console.log(reading)
        this.emit('reading', reading);
    }

    /**
     * Helper to await the very next reading.
     */
    nextReading(): Promise<Reading> {
        return new Promise<Reading>((resolve) => {
            const once = (r: Reading) => {
                this.off('reading', once);
                resolve(r);
            };
            this.on('reading', once);
        });
    }

    //──────────────────────────────────────────────────────────────────────────
    // Static helper: open SerialPort, pipe through ReadlineParser, automatically
    // send “read\r\n” again when the meter stays silent for `gapMillis`.
    //──────────────────────────────────────────────────────────────────────────

    static attach(
        path: string,
        gapMillis = 1000,
    ): SerialPhMeterParser {
        const port = new SerialPort({
            baudRate: 1200,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            autoOpen: true,
            path: path
        });
        const rl = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
        const parser = new SerialPhMeterParser();

        const sendRead = () => {
            if (port.writable) port.write('read\r\n');
        };

        // kick‑off on initial open
        port.once('open', () => {
            sendRead();
            resetTimer();
        });

        /*
         * RE‑TRIGGER LOGIC ------------------------------------------------------
         * Every time a measurement line is received, we reset a timer.  If the
         * timer elapses without new lines (i.e. the meter stopped streaming),
         * we send another “read” command to start the next sequence.
         */
        let inactivityTimer: NodeJS.Timeout | undefined;
        const resetTimer = () => {
            if (inactivityTimer) clearTimeout(inactivityTimer);
            inactivityTimer = setTimeout(sendRead, gapMillis);
        };

        rl.on('data', (line: string) => {
            parser.feed(line);
            resetTimer();
        });

        // Clear timer on port close so Node can exit cleanly.
        port.on('close', () => {
            if (inactivityTimer) clearTimeout(inactivityTimer);
        });

        return parser;
    }
}


