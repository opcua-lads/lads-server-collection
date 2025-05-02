# LADS OPC UA Servers  (Repository Root)

This folder collects individual **OPC UA LADS servers** for distinct device classes.  
Each server

* exposes a LADS-compliant OPC UA endpoint,
* publishes metadata following **Allotrope Foundation Ontologies (AFO)**, and
* generates measurement results in the **Allotrope Simple Model (ASM)** format (Visocmeter and pH-Meter only).

| Device type | Folder | Highlights | Port |
|-------------|--------|------------|------|
| Viscometer  | [`servers/lads-viscometer`](./servers/lads-viscometer/README.md) | Rheometry simulation (temperature & shear-rate dependent viscosity) |  4840  |
| pH-Meter    | [`servers/lads-ph-meter`](./servers/lads-ph-meter/README.md) | Nernst-based pH simulation with temperature compensation and slope/offset calibration helpers |  4841  |
| ULT Freezer | [`servers/lads-freezer`](./servers/lads-freezer/README.md) | Door state machine + 2-point temperature control simulation |  4842  |

> **Status:** All servers are proof-of-concept simulators intended for demos, integration testing and reference implementations.  
> Production-ready hardening (security, persistence, real hardware I/O) is out of scope for now.
> Since the AFO nodeset takes some time to load, you can enable/disable AFO support by setting the const IncludeAFO in the respective server.ts file.

### Getting started (quick tour)

```bash
# 1. install dependencies (workspace root)
npm install   # or npm/yarn

# 2. pick a server
cd servers/viscometer      # ph-meter / ult-freezer also work

# 3. run it
npm start                 # see individual READMEs for options

# 4. point any OPC UA client to  opc.tcp://localhost:<port>