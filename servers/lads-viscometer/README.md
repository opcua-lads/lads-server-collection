# Viscometer LADS OPC UA Server

A simulated viscometer that

* implements the **LADS OPC UA information model** for viscometry,
* annotates nodes with **AFO** metadata,
* produces result data in **ASM** and **XLSX** format, and
* models viscosity as a function of **temperature** and **shear stress**.

## Features

| Capability | Notes |
|------------|-------|
| Rheology model | η(T, γ̇) = η₀ · exp [ α (T – T₀) ] · (1 + β γ̇²) |
| Methods | provided via simple JSON files. Can easily be modified. |
| AFO annotations | generic and reheometry specific |
| ASM output | results available in accordance with rheometry schema as variable or downloadabe as file via OPC UA services |

## Licence
LADS OPC UA servers of this collection which represent real world, non generic, device types are licensed under AGPL v3

## Running

```bash
npm start             # opc.tcp://localhost:4840
