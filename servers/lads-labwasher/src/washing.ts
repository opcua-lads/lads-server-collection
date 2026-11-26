// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Phases of the simulated washing programs of the PG 8583 (by Miele program number = DeviceTemplateId).

A phase fills the chamber (cold water, warm water or DI water = purified water, Miele "AD water"), circulates with the spray arms, doses a
process chemical, heats to its set point and holds it, then drains. The times are shortened for the demo (seconds
instead of minutes); the order and temperatures follow typical Miele lab programs, not the exact factory settings.

Dispenser pumps: 1 alkaline cleaner, 2 neutraliser (acid), 3 additive (emulsifier / rinse aid).
*/

export type Water = "ColdWater" | "WarmWater" | "DIWater"

export interface Phase {
    name: string
    water?: Water
    temperature?: number                                         // set point of the temperature controller (°C)
    dosing?: { pump: number, rate: number, conductivity: number } // dispenser pump 1 … 3, rate %, conductivity added (µS/cm)
    drainOnly?: boolean
    fillMs: number
    circulateMs: number    // without a temperature
    holdMs: number         // at the temperature
    drainMs: number
    estimatedMs: number
}

const FILL = 3000, DRAIN = 2000

const phase = (name: string, water: Water | undefined, options: Partial<Phase> = {}): Phase => {
    const p: Phase = { name, water, fillMs: water ? FILL : 0, circulateMs: 5000, holdMs: 6000, drainMs: DRAIN, estimatedMs: 0, ...options }
    const heating = p.temperature ? (p.temperature - 20) * 250 : 0   // rough estimate of the heating time of the simulation
    p.estimatedMs = p.fillMs + (p.dosing ? 3000 : 0) + (p.temperature ? heating + p.holdMs : p.circulateMs) + p.drainMs
    return p
}

const prewash = (water: Water = "ColdWater") => phase("Prewash", water)
const clean = (temperature: number, rate = 40, holdMs = 6000) => phase("Cleaning", "WarmWater", { temperature, holdMs, dosing: { pump: 1, rate, conductivity: 450 } })
const acidClean = (temperature: number, rate = 40) => phase("Acid cleaning", "WarmWater", { temperature, dosing: { pump: 2, rate, conductivity: 300 } })
const neutralise = (pump = 2, rate = 20) => phase("Neutralisation", "WarmWater", { dosing: { pump, rate, conductivity: 200 } })
const rinse = (n?: number) => phase(n ? `Interim rinse ${n}` : "Interim rinse", "WarmWater")
const finalRinse = (temperature?: number) => phase("Final rinse (DI water)", "DIWater", temperature ? { temperature, holdMs: 4000 } : {})

const PROGRAMS: { [number: string]: Phase[] } = {
    "49": [prewash(), clean(55), neutralise(), rinse(), finalRinse(75)],                                    // Universal
    "2": [prewash(), clean(60, 30), rinse(), finalRinse(70)],                                               // Standard
    "9": [prewash(), prewash(), clean(93, 60, 8000), neutralise(2, 30), rinse(1), rinse(2), finalRinse(80)], // Intensive
    "27": [prewash(), acidClean(60, 50), neutralise(1, 20), rinse(), finalRinse(70)],                       // Anorganica
    "26": [prewash(), clean(93, 60), neutralise(2, 30), rinse(), finalRinse(80)],                           // Organica
    "25": [prewash(), clean(75, 40), neutralise(), rinse(), finalRinse(75)],                                // Injector Plus
    "29": [prewash(), prewash(), clean(60), neutralise(), rinse(1), rinse(2), rinse(3), finalRinse(75)],    // Pipettes
    "50": [prewash(), clean(55, 30), rinse(), finalRinse(55)],                                              // Plastics
    "58": [clean(50, 20, 4000), finalRinse(60)],                                                            // Mini
    "30": [prewash("WarmWater"), clean(93, 60), phase("Emulsifying", "WarmWater", { temperature: 70, dosing: { pump: 3, rate: 40, conductivity: 150 } }), neutralise(), rinse(), finalRinse(80)], // Oil
    "10": [prewash(), clean(93, 40, 10000), rinse(), finalRinse(75)],                                       // Special 93°C-10'
    "31": [finalRinse(), finalRinse()],                                                                     // DI Water Rinse
    "12": [rinse()],                                                                                        // Rinse
    "13": [phase("Drain", undefined, { drainOnly: true, circulateMs: 4000, drainMs: 0 })],                  // Drain
}

/** the phases of a program (unknown numbers: a short universal program) */
export function programPhases(number: string): Phase[] {
    return PROGRAMS[number] ?? [prewash(), clean(55), finalRinse()]
}
