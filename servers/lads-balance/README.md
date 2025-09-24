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

## License
LADS OPC UA servers of this collection which represent real world, non generic, device types are licensed under **AGPL v3**

## Quick run
```bash
npm run lads-balance             # opc.tcp://localhost:4845
```
## Configuration (config.json)
This document explains the configuration options for `config.json`.
The configuration file must be placed in the application's root directury.

### Example config.json file
The first device entry provides the full set of configuration options.
The second device entry show a minimal version.

```json
{
  "includeAfo": false,
  "port": 4844,
  "devices": [
    {
      "serialPort": "/dev/tty.usbmodem00294063041",
      "protocol": "SBI",
      "name": "My Sartorius Balance",
      "enabled": true,
      "baudRate": 4800,
      "parity": "odd",
      "dataBits": 8,
      "stopBits": 1
    },
    {
      "serialPort": "/dev/tty.PL2303-USBtoUART1130",
      "protocol": "SICS",
      "name": "My Mettler Toledo Balance",
    }
  ]
}
```

## Configuration reference

### Top level
| Key        | Type    | Required | Default | Example   | Description                                       |
| ---------- | ------- | :------: | ------: | --------- | ------------------------------------------------- |
| includeAfo | boolean |    No    |    true | false     | Include AFO semantic labels in the OPC UA server. |
| port       | number  |    No    |    4844 | 4844      | OPC UA server port number.                        |
| devices    | array   |    Yes   |       - | see below | List of balance devices to connect.               |

### Device object
| Key        | Type    | Required | Default | Example                        | Description                                                    |
| ---------- | ------- | :------: | ------: | ------------------------------ | -------------------------------------------------------------- |
| serialPort | string  |    Yes   |       - | "/dev/tty.usbmodem00294063041" | Serial port path (mandatory for real, non-simulated balances). |
| protocol   | enum    |    Yes   |       - | "SBI"                          | Communication protocol: SBI, SICS, or Simulated.               |
| name       | string  |    Yes   |       - | "My Sartorius Balance"         | Nickname for the device; must be unique within the list.       |
| enabled    | boolean |    No    |    true | false                          | Connect to this device at startup.                             |
| baudRate   | number  |    No    |    9600 | 4800                           | Serial port baud rate.                                         |
| parity     | enum    |    No    |  "none" | "odd"                          | Serial port parity: none, even, or odd.                        |
| dataBits   | number  |    No    |       8 | 7                              | Number of data bits: 7 or 8.                                   |
| stopBits   | number  |    No    |       1 | 2                              | Number of stop bits: 1, 1.5, or 2.                             |
