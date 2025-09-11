# Balance LADS OPC UA Server

## Features
* tare function
* preset tare to predefined value
* reset tare
* zero function
* weighing function including creation of ASM result files
* semantic annotatios based on AFO ontolgy labels

## Simulation mode
* all features listed above
* input of simualted tare and net values

## Gateway mode
Currently supports serial connectivity utilizing Mettler Toledo SICS and sartorius SBT protocols.
* supported features depend on protocol and device specific protocol support
* on startup of the application provide the serial port via argument **-p serialport**

## FAIR data
* rich **AFO** metadata, and
* **ASM** result payloads for end-point measurements in accordance with the ASM Balance schema.

## Licence
LADS OPC UA servers of this collection which represent real world, non generic, device types are licensed under AGPL v3

## Quick run

```bash
npm run lads-balance             # opc.tcp://localhost:4845
