// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 * Background task which keeps the Location (MachineIdentification) of a device in sync with its HierarchicalLocation.
 *
 * It subscribes to the HierarchicalLocation variable and, at startup and whenever the value changes (e.g. written by a client),
 * resolves the GPS location and writes it to the Location property. Resolution order:
 *   1. "location" of the matching named site in config/lads-site.json (manual)
 *   2. "geocodeCache" of config/lads-site.json (result of an earlier lookup, read fresh from the file)
 *   3. web lookup in OpenStreetMap (Nominatim), the result is stored in "geocodeCache"
 * If anything fails (offline, nothing found, ..) the current Location is silently kept. A top-level "location" in the config
 * (applies to all sites) or "geocode": false (or LADS_SITE_GEOCODE=0) disables the task. See lads-site-config.ts.
 */

import { readFileSync } from "fs"
import { UAVariable } from "node-opcua"
import { LADSComponent, MachineIdentificationType } from "@interfaces"
import { Site, LADSSiteConfig, geocode, cacheLocation } from "./lads-site-config"
import { getStringValue, setStringValue } from "./lads-variable-utils"

function readGeocodeCache(): { [hierarchicalLocation: string]: string } {
    try {
        return Site.file ? (JSON.parse(readFileSync(Site.file, "utf8")) as LADSSiteConfig).geocodeCache ?? {} : {}
    } catch {
        return {}
    }
}

/** Resolves the GPS location of a hierarchical location (named site -> cache -> web). Never throws. */
export async function resolveLocation(hierarchicalLocation: string): Promise<{ location: string, source: string } | undefined> {
    try {
        const site = Site.hierarchicalLocations.find(site => site.value === hierarchicalLocation && site.location)
        if (site) return { location: site.location!, source: `site ${site.label}` }
        const cached = readGeocodeCache()[hierarchicalLocation]
        if (cached) return { location: cached, source: "cache" }
        const location = await geocode(hierarchicalLocation)
        if (!location) return undefined
        if (Site.file) {
            try { cacheLocation(Site.file, hierarchicalLocation, location) } catch { /* caching is optional */ }
        }
        return { location, source: "web" }
    } catch {
        return undefined
    }
}

export class GeoLocationUpdater {
    private timer?: ReturnType<typeof setTimeout>

    /** installs the background task if the lookup is enabled and the component has a HierarchicalLocation */
    static install(component: LADSComponent): GeoLocationUpdater | undefined {
        if (!Site.geocode || Site.locationSource === "config" || !component.hierarchicalLocation) return undefined
        return new GeoLocationUpdater(component, component.hierarchicalLocation)
    }

    private constructor(private component: LADSComponent, private hierarchicalLocation: UAVariable) {
        hierarchicalLocation.on("value_changed", () => this.schedule(1000))     // debounce successive writes
        this.schedule(500)                                                      // initial resolution after startup
    }

    private schedule(delayMilliSeconds: number) {
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => { void this.update() }, delayMilliSeconds)
        ;(this.timer as unknown as { unref?: () => void }).unref?.()     // do not keep the process alive for a pending lookup
    }

    private async update(): Promise<void> {
        try {
            const value = getStringValue(this.hierarchicalLocation, "")
            if (!value) return
            const resolved = await resolveLocation(value)
            if (!resolved) return                                                   // silently keep the current location
            if (getStringValue(this.hierarchicalLocation, "") !== value) return     // changed during lookup: the next update follows
            const nodes = [this.component, this.component.identification] as (MachineIdentificationType | undefined)[]
            nodes.forEach(node => node?.location ? setStringValue(node.location, resolved.location) : 0)
            console.log(`Location of ${this.component.getDisplayName()}: ${resolved.location} for ${value} [${resolved.source}]`)
        } catch {
            // silently keep the current location
        }
    }
}
