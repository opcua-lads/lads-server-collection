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
 * Several server processes start together and look up the same new site: the web lookup waits a random few seconds and reads the
 * cache again first, so usually only one process asks Nominatim (at most one request per second is allowed) and the others take
 * its cached result. If the lookup fails (offline, rate limit, timeout, nothing found) the current Location is kept, the reason
 * is logged once, and the lookup is retried after 30 s, 2 min, 10 min and then every hour until it succeeds or the
 * HierarchicalLocation changes. A top-level "location" in the config (applies to all sites) or "geocode": false
 * (or LADS_SITE_GEOCODE=0) disables the task. See lads-site-config.ts.
 */

import { readFileSync } from "fs"
import { UAVariable } from "node-opcua"
import { LADSComponent, MachineIdentificationType } from "@interfaces"
import { Site, LADSSiteConfig, geocodeDetailed, cacheLocation } from "./lads-site-config"
import { getStringValue, setStringValue } from "./lads-variable-utils"

function readGeocodeCache(): { [hierarchicalLocation: string]: string } {
    try {
        return Site.file ? (JSON.parse(readFileSync(Site.file, "utf8")) as LADSSiteConfig).geocodeCache ?? {} : {}
    } catch {
        return {}
    }
}

const RetryDelays = [30_000, 120_000, 600_000, 3_600_000]     // after a failed lookup; the last one repeats
const StaggerMilliSeconds = 8_000                               // random wait before a web lookup (processes starting together)

/** The GPS location from the configuration: named site with a manual location, or the geocode cache (read fresh from the file). */
function configuredLocation(hierarchicalLocation: string): { location: string, source: string } | undefined {
    const site = Site.hierarchicalLocations.find(site => site.value === hierarchicalLocation && site.location)
    if (site) return { location: site.location!, source: `site ${site.label}` }
    const cached = readGeocodeCache()[hierarchicalLocation]
    return cached ? { location: cached, source: "cache" } : undefined
}

/**
 * Resolves the GPS location of a hierarchical location (named site -> cache -> web). Never throws.
 * Before a web lookup it waits up to staggerMilliSeconds and looks into the cache again (another process may have found it).
 */
export async function resolveLocation(hierarchicalLocation: string, staggerMilliSeconds = 0): Promise<{ location?: string, source?: string, reason?: string }> {
    try {
        const configured = configuredLocation(hierarchicalLocation)
        if (configured) return configured
        if (staggerMilliSeconds > 0) {
            await new Promise(resolve => setTimeout(resolve, Math.random() * staggerMilliSeconds))
            const meanwhile = configuredLocation(hierarchicalLocation)
            if (meanwhile) return meanwhile
        }
        const result = await geocodeDetailed(hierarchicalLocation)
        if (!result.location) return { reason: result.reason ?? "no result" }
        if (Site.file) {
            try { cacheLocation(Site.file, hierarchicalLocation, result.location) } catch { /* caching is optional */ }
        }
        return { location: result.location, source: "web" }
    } catch (err) {
        return { reason: `${err}` }
    }
}

export class GeoLocationUpdater {
    private timer?: ReturnType<typeof setTimeout>
    private failures = 0                // failed lookups of the current HierarchicalLocation
    private target = ""                 // HierarchicalLocation the failures belong to
    private loggedReason = ""           // a reason is logged once, not on every retry

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
        const name = this.component.getDisplayName()
        try {
            const value = getStringValue(this.hierarchicalLocation, "")
            if (!value) return
            if (value !== this.target) { this.target = value; this.failures = 0; this.loggedReason = "" }
            const resolved = await resolveLocation(value, StaggerMilliSeconds)
            if (getStringValue(this.hierarchicalLocation, "") !== value) return     // changed during lookup: the next update follows
            if (!resolved.location) {
                const delay = RetryDelays[Math.min(this.failures, RetryDelays.length - 1)]
                this.failures++
                if (resolved.reason !== this.loggedReason) {
                    this.loggedReason = resolved.reason ?? ""
                    console.warn(`Location of ${name}: no GPS location for ${value} (${resolved.reason}), keeping the current one, retry in ${Math.round(delay / 1000)} s`)
                }
                this.schedule(delay)
                return
            }
            if (this.failures) console.log(`Location of ${name}: found after ${this.failures} failed lookup(s)`)
            this.failures = 0; this.loggedReason = ""
            const nodes = [this.component, this.component.identification] as (MachineIdentificationType | undefined)[]
            nodes.forEach(node => node?.location ? setStringValue(node.location, resolved.location!) : 0)
            console.log(`Location of ${name}: ${resolved.location} for ${value} [${resolved.source}]`)
        } catch (err) {
            console.warn(`Location of ${name}: update failed (${err}), retry in ${RetryDelays[0] / 1000} s`)
            this.schedule(RetryDelays[0])
        }
    }
}
