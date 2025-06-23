// SPDX-FileCopyrightText: 2025 Dr.x Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Viscometer
Copyright (C) 2025  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { readdir, readFile } from "fs/promises"
import { extname, join } from "path"

//---------------------------------------------------------------
// viscometer program definitions
//---------------------------------------------------------------
export const DataDirectory = join(__dirname, "data")

export interface ViscometerProgram {
    name: string
    author: string
    description: string
    created?: Date
    modified?: Date
    version?: string
    steps: VisometerProgramStep[]
}

export interface VisometerProgramStep {
    name: string
    dt: number
    nsp: number
    tsp: number
}

// Type guard
function isViscometerProgram(obj: any): obj is ViscometerProgram {
    return (
        typeof obj === 'object' &&
        typeof obj.name === 'string' &&
        typeof obj.author === 'string' &&
        typeof obj.description === 'string' &&
        Array.isArray(obj.steps) &&
        obj.steps.every(isVisometerProgramStep)
    )
}

function isVisometerProgramStep(obj: any): obj is VisometerProgramStep {
    return (
        typeof obj === 'object' &&
        typeof obj.name === 'string' &&
        typeof obj.dt === 'number' &&
        typeof obj.nsp === 'number' &&
        typeof obj.tsp === 'number'
    )
}

// Async Loader
export async function loadViscometerProgramsFromDirectory(directory: string): Promise<ViscometerProgram[]> {
    const programs: ViscometerProgram[] = []

    function checkAndPushProgram(parsed: any) {
        if (isViscometerProgram(parsed)) {
            programs.push(parsed)
        } else {
            console.warn(`Invalid schema: ${parsed}`)
        }
    }

    try {
        const files = await readdir(directory)
        for (const file of files) {
            if (extname(file).toLowerCase() === '.json') {
                const filePath = join(directory, file)
                try {
                    const content = await readFile(filePath, 'utf-8')
                    const parsed = JSON.parse(content)
                    // a json file could include one or a list of programs
                    if (Array.isArray(parsed)) {
                        parsed.forEach(value => checkAndPushProgram(value))
                    } else {
                        checkAndPushProgram(parsed)
                    }
                } catch (err) {
                    console.error(`Failed to load file: ${file}`, err)
                }
            }
        }
    }
    catch(err) {
        console.warn(`Viscometer program directory does not exist ${directory}.`)
    }

    return programs
}

const date = new Date(Date.parse("2025-05-01T10:00:00Z"))
const version = "1.0"
export const DefaultViscometerPrograms: ViscometerProgram[] = [
    {
        name: "Analytical Method A (30rpm)",
        author: "AixEngineers",
        created: date,
        modified: date,
        version: version,
        description: "Measure viscosity of the sample at constant shear rate and different temperatures.",
        steps: [
            {name: "Viscosity 30°C", dt: 30000, tsp: 30, nsp: 30},
            {name: "Viscosity 40°C", dt: 30000, tsp: 40, nsp: 30},
            {name: "Viscosity 50°C", dt: 30000, tsp: 50, nsp: 30},
            {name: "Viscosity 60°C", dt: 30000, tsp: 60, nsp: 30},
            {name: "Viscosity 80°C", dt: 30000, tsp: 80, nsp: 30},
            {name: "Viscosity 100°C", dt: 30000, tsp: 100, nsp: 30},
        ]
    },
    {
        name: "Analytical Method B (50rpm)",
        author: "AixEngineers",
        created: date,
        modified: date,
        version: version,
        description: "Measure viscosity of the sample at constant shear rate and different temperatures.",
        steps: [
            {name: "Viscosity 30°C", dt: 30000, tsp: 30, nsp: 50},
            {name: "Viscosity 40°C", dt: 30000, tsp: 40, nsp: 50},
            {name: "Viscosity 50°C", dt: 30000, tsp: 50, nsp: 50},
            {name: "Viscosity 60°C", dt: 30000, tsp: 60, nsp: 50},
            {name: "Viscosity 80°C", dt: 30000, tsp: 80, nsp: 50},
            {name: "Viscosity 100°C", dt: 30000, tsp: 100, nsp: 50},
        ]
    },
    {
        name: "Analytical Method C (short)",
        author: "AixEngineers",
        created: date,
        modified: date,
        version: version,
        description: "Measure viscosity of the sample at constant shear rate and constant temperature.",
        steps: [
            {name: "Viscosity 30°C", dt: 30000, tsp: 30, nsp: 50},
        ]
    },
]
