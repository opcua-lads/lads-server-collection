# pH-Meter LADS OPC UA Server

A fully simulated pH-meter implementation featuring:

* **Nernst-equation** signal model (`pH = (E₀ – E) / (2.303·R·T/F)`),
* temperature compensation,
* deliberate sensor detuning (slope & offset drift),
* **calibration methods** (slope & offset calibration methods),
* rich **AFO** metadata, and
* **ASM** result payloads for profile and end-point measurements in accordance with pH-Meter schema.

## Quick run

```bash
npm start             # opc.tcp://localhost:4841
