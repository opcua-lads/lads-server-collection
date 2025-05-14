# Ultra-Low-Temperature (ULT) Freezer LADS OPC UA Server

A minimalistic ULT-freezer simulator that demonstrates:

* **Door state machine** (Closed, Opening, Open, Closing, Alarm),
* **2-point temperature control** (compressor on/off with hysteresis),

## Running

```bash
npm run lads-freezer             # opc.tcp://localhost:4842
