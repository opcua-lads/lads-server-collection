# LADS OPC UA Servers Collection (Repository Root)

This folder collects individual **OPC UA LADS servers** for distinct device classes.  
Each server

* exposes a LADS-compliant OPC UA endpoint,
* publishes metadata following **Allotrope Foundation Ontologies (AFO)**, and
* generates measurement results in the **Allotrope Simple Model (ASM)** format (Visocmeter and pH-Meter only).

| Device type | Folder | Highlights | Port |
|-------------|--------|------------|------|
| Viscometer  | [`servers/lads-viscometer`](./servers/lads-viscometer/README.md) | Rheometry simulation (temperature & shear-rate dependent viscosity) |  4840  |
| pH-Meter    | [`servers/lads-ph-meter`](./servers/lads-ph-meter/README.md) | pH sensor simulation/real world device gateway with temperature compensation and slope/offset calibration (simulation only) |  4841  |
| Balance     | [`servers/lads-balance`](./servers/lads-balance/README.md) | Laboratory balance gateway which supports SBI (sartorius) and SICS Level 1 (Mettler Toledo and others) protocol compliant balances  |  4844  |
| ULT Freezer | [`servers/lads-freezer`](./servers/lads-freezer/README.md) | Door state machine + 2-point temperature control simulation |  4842  |

> **Status:** All servers are proof-of-concept simulators intended for demos, integration testing and reference implementations.  
> Production-ready hardening (security, persistence, real hardware I/O) is out of scope for now.
> Since the AFO nodeset takes some time to load, you can enable/disable AFO support by setting the const IncludeAFO in the respective server.ts file.

### License Information

[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![AGPL v3 License](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.html)

The majority of the source code in this repository is licensed under the [MIT License](https://opensource.org/licenses/MIT).  
Source code specifically related to "real-world" device types is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](https://www.gnu.org/licenses/agpl-3.0.html).

Please refer to the license header within each individual source file for precise licensing details.

For information on third-party components:
- Licensing details for the Allotrope Simple Models (ASM) can be found [here](https://www.allotrope.org/asm).
- Licensing details for the Allotrope Foundation Ontology (AFO) are available [here](https://www.allotrope.org/ontologies).

### Getting started (quick tour)

```bash
# 1. install dependencies (workspace root)
npm install   # or npm/yarn

# 2. run it
npm run <server-name>       # see individual READMEs for options

# 3. point any OPC UA client to  opc.tcp://localhost:<port>
