// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Viscometer
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
import { SerialPort, ReadlineParser } from 'serialport';
import { DataValue } from 'node-opcua';
import { LADSAnalogControlFunction, LADSComponent, LADSFunctionalState } from '@interfaces';
import { AnalogControlFunctionImpl, getNumericValue, initComponent, LADSComponentOptions, raiseEvent, setNumericValue } from '@utils';
import { AFODictionary, AFODictionaryIds } from '@afo';
import { ViscometerUnitImpl } from './unit';
import { ControllerOptions } from './server';
import { ControllerImpl } from './controller';

//---------------------------------------------------------------
// abstract temperature controller implementation
//---------------------------------------------------------------
export class TemperatureControllerImpl extends ControllerImpl {
    temperatureControlFunction: TemperatureControlFunction
    constructor(parent: ViscometerUnitImpl, options: ControllerOptions, component?: LADSComponent) {
        super(parent, options)
        const functionSet = parent.functionalUnit.functionSet
        const port = options?.serialPort ?? ""
        this.temperatureControlFunction = port.length > 0 ? new TemperatureControlFunctionThermosel(functionSet.temperatureController, port) : new TemperatureControlFunctionSimulator(functionSet.temperatureController)

        if (component) {
            const componentOptions = this.defaultComponentOptions()
            componentOptions.manufacturer = "AMETEK Brookfield",
            componentOptions.model= "Thermosel"
            initComponent(component, componentOptions)
        }
    }

    start() { this.temperatureControlFunction.start() }
    stop() { this.temperatureControlFunction.stop() }
}

//---------------------------------------------------------------
// abstract temperature control function implementation
//---------------------------------------------------------------
export abstract class TemperatureControlFunction extends AnalogControlFunctionImpl {

    constructor(controller: LADSAnalogControlFunction) {
        super(controller, 50.0, 25.0)
        controller.targetValue.on("value_changed", (dataValue => { raiseEvent(this.controller, `Temperature set-point changed to ${dataValue.value.value}°C`) }))
        AFODictionary.addControlFunctionReferences(this.controller, AFODictionaryIds.temperature_controller, AFODictionaryIds.temperature)
    }
}

//---------------------------------------------------------------
// simulated temperature control function implementation
//---------------------------------------------------------------
export class TemperatureControlFunctionSimulator extends TemperatureControlFunction {

    constructor(controller: LADSAnalogControlFunction) {
        super(controller)
        const dT = 200
        setInterval(() => this.evaluateController(dT), dT)
    }

    private evaluateController(dT: number) {
        const running = this.controllerState.getCurrentState().includes(LADSFunctionalState.Running)
        const sp = running ? getNumericValue(this.controller.targetValue) : 25
        const pv = getNumericValue(this.controller.currentValue)
        const noise = 0.02 * (Math.random() - 0.5)
        const cf = running ? dT / 2000 : dT / 10000
        const newpv = (cf * sp) + (1.0 - cf) * pv + noise
        setNumericValue(this.controller.currentValue, newpv)
    }
}

//---------------------------------------------------------------
// thermosel temperature control function implementation
//---------------------------------------------------------------
export class TemperatureControlFunctionThermosel extends TemperatureControlFunction {
    fromDevice = false
    temperatureController: ThermoselController

    constructor(controller: LADSAnalogControlFunction, port: string) {
        super(controller)

        // inizialize temperature controller
        const temperatureController = new ThermoselController({ port: port, pollInterval: 1000 });
        this.temperatureController = temperatureController
        temperatureController.on('state', this.handleStateChanged.bind(this));
        temperatureController.on('temperature', this.handelCurrentValueChanged.bind(this));
        temperatureController.on('target', this.handleTargetValueChanged.bind(this));
        temperatureController.on('error', this.handleError.bind(this));
        this.controller.targetValue.on("value_changed", (dataValue: DataValue) => {
            if (!this.fromDevice) temperatureController.targetValue = Number(dataValue.value.value)
        })
    }

    protected enterStart(): void { this.temperatureController.run()}
    protected enterStop(): void { this.temperatureController.standby()}

    private handleStateChanged(state: ThermoselState) {
        if (state === "RUN") {
            this.controllerState.setState(LADSFunctionalState.Running)
        } else if (state === "STANDBY") {
            this.controllerState.setState(LADSFunctionalState.Stopped)
        } else if (state === "ALARM") {
            this.controllerState.setState(LADSFunctionalState.Aborted)
        }
    }

    private handelCurrentValueChanged(value: number) {
        setNumericValue(this.controller.currentValue, value)
    }

    private handleTargetValueChanged(value: number) {
        this.fromDevice = true
        setNumericValue(this.controller.targetValue, value)
        this.fromDevice = false
    }

    private handleError(err: Error) {

    }
}

//---------------------------------------------------------------
// thermosel RS232 protocol implmentation
//---------------------------------------------------------------
export type ThermoselState = 'RUN' | 'STANDBY' | 'ALARM';

export interface ThermoselControllerOptions {
    /** Serial device path, e.g. 'COM3' or '/dev/ttyAMA0' */
    port: string;
    /** Baud rate (Brookfield default is 9600) */
    baudRate?: number;
    /** Polling interval in ms (0 to disable, default 1000) */
    pollInterval?: number;
    /** Units to send in RS commands ('C' or 'F'), default 'C' */
    units?: 'C' | 'F';
}

export class ThermoselController extends EventEmitter {
    private readonly port: SerialPort;
    private readonly parser: ReadlineParser;
    private pollTimer?: NodeJS.Timeout;

    private _state: ThermoselState = 'STANDBY';
    private _currentValue = NaN;
    private _targetValue = NaN;
    private readonly units: 'C' | 'F';

    constructor(opts: ThermoselControllerOptions) {
        super();

        this.units = opts.units ?? 'C';

        this.port = new SerialPort({
            path: opts.port,
            baudRate: opts.baudRate ?? 9600,
            dataBits: 8,
            parity: 'none',
            stopBits: 1,
            autoOpen: false,
        });

        // Brookfield replies end with CR, so a readline parser is ideal.
        this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\r' }));
        this.parser.on('data', (line: string) => this.handleLine(line));
        this.port.on('error', (err) => this.emit('error', err));

        this.port.open((err) => {
            if (err) {
                this.emit('error', err);
                return;
            }

            // Ask for current set-point & state immediately.
            this.write('S');

            const interval = opts.pollInterval ?? 1000;
            let i = 0
            if (interval > 0) {
                this.pollTimer = setInterval(() => {
                    if (i++ === 5) {
                        this.write('S'); // Get set-point every 5 intervals
                        i = 0;
                    } else {
                        this.write('T'); // Get current temperature every interval
                    }
                }, interval);
            }
        });
    }

    // ── public API ────────────────────────────────────────────────────────────
    /** Current Thermosel state (readonly) */
    get state(): ThermoselState {
        return this._state;
    }

    /** Latest bath temperature (readonly) */
    get currentValue(): number {
        return this._currentValue;
    }

    /** Target set-point (read/write, °C) */
    get targetValue(): number {
        return this._targetValue;
    }

    set targetValue(value: number) {
        if (Number.isNaN(value)) throw new TypeError('targetValue must be a number');
        const scaled = Math.round(value * 10).toString().padStart(4, '0'); // 45.7 → '0457'
        this.write(`RS${scaled}${this.units}`);
    }

    /** Put controller into STANDBY (heater off) */
    standby(): void {
        this.write('RA2');
    }

    /** Start controlling to set-point (RUN) */
    run(): void {
        this.write('RA1');
    }

    /** Stop polling & close serial port */
    close(): void {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.port.close();
    }

    // ── implementation helpers ────────────────────────────────────────────────
    private write(cmd: string): void {
        this.port.write(`${cmd}\r`);
    }

    private handleLine(line: string): void {
        // Ignore echoes of our own commands.
        if (/^(RS|RA)/.test(line)) return;

        // Lines look like: 'T2345C1', 'S1004C2', or '?' on error.
        const kind = line[0] as 'T' | 'S' | '?';
        if (kind === '?') {
            this.emit('error', new Error('Controller did not recognise last command'));
            return;
        }

        const raw = line.slice(1, 5);          // 4-digit value ×10
        const code = Number(line[6]);          // 1 or 2 or alarms
        const newState: ThermoselState = code === 1 ? 'RUN' : code === 2 ? 'STANDBY' : 'ALARM';

        if (newState !== this._state) {
            this._state = newState;
            this.emit('state', newState);
        }

        const value = Number(raw) / 10;
        if (kind === 'T' && value !== this._currentValue) {
            this._currentValue = value;
            this.emit('temperature', value);
        }
        if (kind === 'S' && value !== this._targetValue) {
            this._targetValue = value;
            this.emit('target', value);
        }
    }
}

function testThermosel() {
    // Example usage:
    const temperatureController = new ThermoselController({ port: '/dev/tty.usbserial-2110', pollInterval: 1000 });

    temperatureController.on('state', (state) => console.log(`State changed to: ${state}`));
    temperatureController.on('temperature', (temp) => console.log(`Current temperature: ${temp}°C`));
    temperatureController.on('target', (target) => console.log(`Target set-point: ${target}°C`));
    temperatureController.on('error', (err) => console.error(`Error: ${err.message}`));

    // Set target temperature
    temperatureController.targetValue = 45.7;

    // Start controlling
    temperatureController.run();

    // Stop after some time
    setTimeout(() => {
        temperatureController.standby();
        temperatureController.close();
    }, 60000);
}

