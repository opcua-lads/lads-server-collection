# LADS OPC UA Balance Gateway
A LADS OPC UA server which serves as gateway for multiple laboratory balances in parallel.
Since it is based on the LADS OPC UA Companion Specification, it additionally includes and supports the Companion Specifications 
* Device Integration
* Machinery Basics
* Asset Management Basics
Although it is not an implementation of the Weighing Companion Specification it lends on its definitions and naming.

## Supported Protocols
The gataway currently supports the following well known serial protocols
* SICS Level 1 (Mettler Toledo balances and many more)
* SBI (Sartorius balances)
* Simulated balance

## Features
* current weight monitoring
* weight stable monitoring
* tare mode monitoring
* tare weigth monitoring (if supported by protocol)
* zero function
* tare function
* register weight function including creation of ASM result files (see below)
* semantic annotatios based on AFO ontolgy labels

## FAIR by Design
* rich Allotrope Foundation Ontology **AFO** metadata, and
* Allotrope Simple Model **ASM** result generation for end-point measurements in accordance with the ASM Balance schema.

## Licence
LADS OPC UA servers of this collection which represent real world, non generic, device types are licensed under AGPL v3

## Quick run
```bash
npm run lads-balance             # opc.tcp://localhost:4845
```
## Simple configuration via confog.json
```
{
    "includeAfo": false,    // include afo smeantic labels; optional, default is true.
    "port": 4844,           // OPC UA port number; optional, default is 4844
    "devices": [            // list of balance devices
        {
            "serialPort": "/dev/tty.usbmodem00294063041",   // serial port path, mandatory for non simulated balances
            "protocol": "SBI",                              // protocol; mandatory, allowed values SBI | SICS | Simulated 
            "name": "My Sartorius Balance",                 // balance device nick name; mandatory, must be unique within the list of devices
            "enabled": true,                                // try to connect to this device in startup; optional, default is true
            "baudRate": 4800,                               // serial port baudrate; optional, default is 9600
            "parity": "odd",                                // serial port parity; optional, default is "none", allowed values  "none" | "even" | "odd"
            "dataBits": 8,                                  // serial port databits; optional, default is 8, allowed values 7 | 8
            "stopBits": 1,                                  // serial port stopbits; optional, default is 1, allowed values 1 | 1.5 | 2
        },
        {
            "serialPort": "/dev/tty.PL2303-USBtoUART1130",
            "protocol": "SICS",
            "name": "My Mettler Toledo Balance",
            "enabled": true
        }
    ]
}
```