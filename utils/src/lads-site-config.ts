// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 * Site configuration (location and hierarchical location shown in the device nameplates).
 *
 * The configuration is optional. It is read from config/lads-site.json (project root, or out/config after a build).
 * Without a file, or with an unknown site label, the single hard coded fallback ("essentim Office") is used.
 *
 * Site selection, highest priority first:
 *   0. per device:          the site whose "devices" array holds the device's ProductInstanceUri:
 *                           "hierarchicalLocations": [{ "label": "Lab 2", "value": "DE/.../Lab_2", "devices": ["<uri>", ...] }]
 *                           (devices of one server, even of one DeviceSet, can be at different places, e.g. two labs at one
 *                           site). Still read: the older map "devices": { "<ProductInstanceUri>": "<label>" | "<location>" }
 *   1. command line:        --site "<label>"
 *   2. environment:         LADS_SITE=<label>
 *   3. per server entry:    "servers": { "lads-viscometer": "<label>" }
 *   4. config default:      "hierarchicalLocation": "<label>"
 *   5. hard coded fallback: essentim Office
 * The file location can be overridden with the environment variable LADS_SITE_CONFIG.
 *
 * GPS location (MachineIdentification Location), highest priority first:
 *   1. "location" of the selected preset (manual)
 *   2. "location" at the top level of the config (manual, applies to all sites and disables the lookup)
 *   3. "geocodeCache" entry of the config (result of an earlier web lookup)
 *   4. hard coded fallback
 * If none of 1-3 exists, refreshSiteLocation() looks up the hierarchical location in OpenStreetMap (Nominatim) in the background,
 * stores the result in "geocodeCache" of the config file and uses it from the next start on. Any failure is silent.
 * The lookup sends the address derived from the hierarchical location to nominatim.openstreetmap.org.
 * Disable it with "geocode": false in the config or LADS_SITE_GEOCODE=0.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs"
import { join, resolve } from "path"

export interface NamedHierarchicalLocation {
    label: string
    value: string
    location?: string       // optional manual GPS location of this site
    devices?: string[]      // ProductInstanceUris of the devices at this site (devices that differ from their server's site)
}

export interface LADSSiteConfig {
    location?: string
    hierarchicalLocation?: string
    hierarchicalLocations?: NamedHierarchicalLocation[]
    servers?: { [serverName: string]: string }
    devices?: { [productInstanceUri: string]: string }
    geocode?: boolean
    geocodeCache?: { [hierarchicalLocation: string]: string }
}

export interface LADSSite {
    location: string
    hierarchicalLocation: string
    hierarchicalLocationLabel: string
    hierarchicalLocations: NamedHierarchicalLocation[]
    source: string
    file?: string
    locationSource: "preset" | "config" | "cache" | "fallback"
    geocode: boolean
    devices: { [productInstanceUri: string]: string }
}

// the only hard coded values
const FallbackLocation = "N 51.257315 E 6.740885"
const FallbackHierarchicalLocation: NamedHierarchicalLocation = { label: "essentim Office", value: "DE/Munich/Schragenhofstr_35/A/Office" }

function readSiteConfig(): { config: LADSSiteConfig, file?: string } {
    const candidates = [
        process.env.LADS_SITE_CONFIG,
        join(process.cwd(), "config", "lads-site.json"),
        resolve(__dirname, "..", "..", "config", "lads-site.json")
    ]
    for (const file of candidates) {
        if (!file || !existsSync(file)) continue
        try {
            return { config: JSON.parse(readFileSync(file, "utf8")) as LADSSiteConfig, file }
        } catch (err) {
            console.warn(`Site configuration ${file} ignored: ${err}`)
        }
    }
    return { config: {} }
}

function commandLineValue(name: string): string | undefined {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] : undefined
}

function serverName(): string | undefined {
    // e.g. servers/lads-viscometer/src/server.ts (ts-node) or out/servers/lads-viscometer/src/server.js
    return /servers[\\/](lads-[^\\/]+)[\\/]/.exec(process.argv[1] ?? "")?.[1]
}

export function loadSite(): LADSSite {
    const { config, file } = readSiteConfig()
    const locations = [FallbackHierarchicalLocation, ...(config.hierarchicalLocations ?? [])]
    const name = serverName()
    const label = commandLineValue("--site") ?? process.env.LADS_SITE ?? (name ? config.servers?.[name] : undefined) ?? config.hierarchicalLocation ?? FallbackHierarchicalLocation.label
    let entry = locations.slice().reverse().find(location => location.label === label)     // entries of the config file win over the fallback
    if (!entry) {
        console.warn(`Unknown site "${label}", using "${FallbackHierarchicalLocation.label}".`)
        entry = FallbackHierarchicalLocation
    }
    const cached = config.geocodeCache?.[entry.value]
    const locationSource: LADSSite["locationSource"] = entry.location ? "preset" : config.location ? "config" : cached ? "cache" : "fallback"
    return {
        location: entry.location ?? config.location ?? cached ?? FallbackLocation,
        locationSource,
        geocode: config.geocode !== false && process.env.LADS_SITE_GEOCODE !== "0",
        file,
        hierarchicalLocation: entry.value,
        hierarchicalLocationLabel: entry.label,
        hierarchicalLocations: locations,
        devices: config.devices ?? {},
        source: file ?? "built-in fallback"
    }
}

/**
 * The site of one device: the hierarchicalLocations entry whose "devices" array lists its ProductInstanceUri, else the older
 * "devices" map of the configuration, by its ProductInstanceUri (unique per device instance,
 * DI). The value is the label of a hierarchicalLocations entry or directly a hierarchical location ("DE/Aachen/.../Lab_2").
 * Undefined when the device has no entry: it uses the site of its server.
 */
export function siteOfDevice(productInstanceUri: string | undefined): NamedHierarchicalLocation | undefined {
    if (!productInstanceUri) return undefined
    // case and blanks do not matter: "sartorius.com/arium pro VF/4711" fits "sartorius.com/arium-pro-VF/4711"
    const normalize = (uri: string) => uri.trim().toLowerCase().replace(/\s+/g, "-")
    const uri = normalize(productInstanceUri)
    const site = Site.hierarchicalLocations.slice().reverse().find(location => location.devices?.some(d => normalize(d) === uri))
    if (site) return site
    const key = Object.keys(Site.devices).find(k => normalize(k) === uri)
    if (!key) return undefined
    const value = Site.devices[key].trim()
    const preset = Site.hierarchicalLocations.slice().reverse().find(location => location.label === value)
    if (preset) return preset
    if (value.includes("/")) return { label: value, value }
    console.warn(`Site of device ${productInstanceUri}: unknown site "${value}" (neither a label nor a hierarchical location), ignored.`)
    return undefined
}

export const Site: LADSSite = loadSite()
let siteReported = false

//---------------------------------------------------------------
// geographical lookup of the hierarchical location
//---------------------------------------------------------------

/** Builds a Nominatim query from a hierarchical location like "/DE/Munich/Schragenhofstr_35/A/Office" (country/city/street/..). */
export function buildGeocodeQuery(hierarchicalLocation: string): { q: string, countrycodes?: string } {
    const segments = hierarchicalLocation.split("/").map(segment => segment.trim()).filter(segment => segment.length > 0)
    const hasCountry = segments.length > 0 && /^[A-Za-z]{2}$/.test(segments[0])
    const parts = (hasCountry ? segments.slice(1, 3) : segments.slice(0, 2)).map(part => part.replace(/_/g, " "))
    return { q: parts.reverse().join(", "), countrycodes: hasCountry ? segments[0].toLowerCase() : undefined }
}

export function formatGPSLocation(latitude: number, longitude: number): string {
    return `${latitude >= 0 ? "N" : "S"} ${Math.abs(latitude).toFixed(6)} ${longitude >= 0 ? "E" : "W"} ${Math.abs(longitude).toFixed(6)}`
}

const pendingGeocodes = new Map<string, Promise<string | undefined>>()

/** Looks up the GPS location of a hierarchical location (Nominatim). Parallel requests for the same location share one web request. */
export function geocode(hierarchicalLocation: string): Promise<string | undefined> {
    let pending = pendingGeocodes.get(hierarchicalLocation)
    if (!pending) {
        pending = geocodeRequest(hierarchicalLocation).finally(() => pendingGeocodes.delete(hierarchicalLocation))
        pendingGeocodes.set(hierarchicalLocation, pending)
    }
    return pending
}

async function geocodeRequest(hierarchicalLocation: string): Promise<string | undefined> {
    const query = buildGeocodeQuery(hierarchicalLocation)
    if (!query.q) return undefined
    const params = new URLSearchParams({ format: "jsonv2", limit: "1", q: query.q })
    if (query.countrycodes) params.set("countrycodes", query.countrycodes)
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { "User-Agent": "lads-server-examples (AixEngineers)", "Accept": "application/json" },
        signal: AbortSignal.timeout(4000)
    })
    if (!response.ok) return undefined
    const results = await response.json() as { lat: string, lon: string }[]
    const latitude = Number(results?.[0]?.lat)
    const longitude = Number(results?.[0]?.lon)
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? formatGPSLocation(latitude, longitude) : undefined
}

export function cacheLocation(file: string, hierarchicalLocation: string, location: string) {
    // read again to not overwrite changes made meanwhile
    const config = JSON.parse(readFileSync(file, "utf8")) as LADSSiteConfig
    config.geocodeCache = { ...config.geocodeCache, [hierarchicalLocation]: location }
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(config, null, 4) + "\n")
    renameSync(temp, file)
}

/**
 * Looks up the GPS location of the active hierarchical location, if no location is configured or cached yet.
 * Never throws and never blocks the startup (call without await). The result is stored in the config file and used from the next start on.
 */
export async function refreshSiteLocation(): Promise<void> {
    // reported by the device servers (createServer), not on every import of the utils (e.g. by the Local Discovery Server)
    if (!siteReported) {
        siteReported = true
        console.log(`Site: ${Site.hierarchicalLocationLabel} (${Site.hierarchicalLocation}), ${Site.location} (${Site.locationSource}) [${Site.source}]`)
    }
    try {
        if (!Site.geocode || Site.locationSource !== "fallback") return
        const location = await geocode(Site.hierarchicalLocation)
        if (!location) return
        if (Site.file) cacheLocation(Site.file, Site.hierarchicalLocation, location)
        console.log(`Site: location of ${Site.hierarchicalLocation} is ${location}${Site.file ? ", cached in " + Site.file + " (used from next start)" : ""}`)
    } catch {
        // silent fallback to the default location
    }
}
