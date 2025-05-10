# pH-Meter LADS OPC UA Server

## Simulation mode
A fully simulated pH-meter implementation featuring:
* **Nernst-equation** signal model (`pH = (E₀ – E) / (2.303·R·T/F)`),
* temperature compensation,
* deliberate sensor detuning (slope & offset drift),
* **calibration methods** (slope & offset calibration methods),

## Gateway mode
Currently supports serial connectivity to Mettler Toledo SevenEasy pH-meter.
* on startup of the application provide the serial port via argument **-p serialport**
* due to the device's capabilities remote calibration is not supported

## FAIR data
* rich **AFO** metadata, and
* **ASM** result payloads for profile and end-point measurements in accordance with the ASM pH-Meter schema.

## Licence
LADS OPC UA servers of this collection which represent real world, non generic, device types are licensed under AGPL v3

## Quick run

```bash
npm start             # opc.tcp://localhost:4841
