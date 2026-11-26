// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
Allotrope Foundation Ontology (AFO) references of the HPLC (HasDictionaryEntry to AFO_Dictionary.NodeSet2.xml), as in
the other example servers: the defaults of the LADS model (AFODictionary.addDefaultDeviceReferences: nameplates,
states, functions, program templates) plus the chromatography specific terms of the device, its components, functions,
program templates and results. Without the AFO dictionary nodeset (server option --no-afo) nothing is added.
*/

import { UAObject, UAVariable } from "node-opcua"
import { AFODictionary, AFODictionaryIds as Ids } from "@afo"
import { LADSDevice, LADSResult } from "@interfaces"

const child = (node: UAObject | null | undefined, ...path: string[]): UAObject | null => {
    let n: UAObject | null | undefined = node
    for (const name of path) n = n?.getChildByName(name) as UAObject | null
    return n ?? null
}
const add = (node: UAObject | UAVariable | null | undefined, ...ids: string[]) => { if (node) AFODictionary.addReferences(node, ...ids) }

/** device, components, functional unit, functions, program templates */
export function addHPLCReferences(device: LADSDevice) {
    const dev = device as unknown as UAObject
    AFODictionary.addDefaultDeviceReferences(device)
    add(dev, Ids.high_performance_liquid_chromatograph, Ids.LC_UV_system, Ids.chromatograph)

    // components (nameplates come from the defaults)
    const components = child(dev, "Components")
    add(child(components, "AutoSampler"), Ids.autosampler)
    add(child(components, "Pump"), Ids.pump, Ids.pump_system)
    add(child(components, "ColumnCompartment"), Ids.column_compartment)
    for (const c of ["Column1", "Column2", "Column3"]) add(child(components, "ColumnCompartment", "Components", c), Ids.high_performance_liquid_chromatography_column, Ids.chromatography_column)
    const dad = child(components, "DAD")
    add(dad, Ids.diode_array_detector, Ids.liquid_chromatography_detector, Ids.chromatographic_detector)
    add(child(dad, "Components", "VisLamp"), Ids.visible_lamp, Ids.lamp)
    add(child(dad, "Components", "UVLamp"), Ids.UV_lamp, Ids.deuterium_lamp, Ids.lamp)
    for (const ch of ["DAD1A", "DAD1B", "DAD1C", "DAD1D"]) {
        const c = child(dad, "Components", ch)
        add(c, Ids.detector)
        add(child(c, "Wavelength"), Ids.detector_wavelength_setting, Ids.wavelength)
    }

    // functional unit and its functions
    for (const unit of (child(dev, "FunctionalUnitSet")?.getComponents() ?? []) as UAObject[]) {
        add(unit, Ids.high_performance_liquid_chromatograph, Ids.high_performance_liquid_chromatography, Ids.liquid_chromatography)
        const fs = child(unit, "FunctionSet")

        const oven = child(fs, "ColumnOven")
        AFODictionary.addControlFunctionReferences(oven as any, Ids.temperature_controller, Ids.temperature)
        add(oven, Ids.column_compartment, Ids.oven)
        add(child(oven, "TargetValue"), Ids.column_compartment_temperature_setting)

        const pump = child(fs, "Pump")
        AFODictionary.addControlFunctionReferences(pump as any, Ids.pump, Ids.flow_rate)
        add(pump, Ids.mobile_phase_delivery)
        add(child(pump, "TargetValue"), Ids.pump_flow_rate_setting_of_chromatography)
        add(child(pump, "TargetValueSet", "Flow"), Ids.pump_flow_rate_setting_of_chromatography, Ids.flow_rate)
        add(child(pump, "TargetValueSet", "PercentageSolventB"), Ids.pump_mobile_phase_ratio_setting_of_chromatography)
        AFODictionary.addSensorFunctionReferences(child(pump, "FunctionSet", "Pressure") as any, Ids.pressure_sensor, Ids.pressure_measurement, Ids.pressure)
        for (const s of ["SolventA", "SolventB"]) {
            const solvent = child(pump, "FunctionSet", s)
            AFODictionary.addControlFunctionReferences(solvent as any, Ids.solvent_channel, Ids.flow_rate)
            add(solvent, Ids.mobile_phase)
        }

        const injector = child(fs, "SampleInjector")
        AFODictionary.addControlFunctionReferences(injector as any, Ids.injection_device, Ids.volume)
        add(injector, Ids.injection_of_chromatography)
        add(child(injector, "TargetValue"), Ids.injection_volume_setting)
        add(child(injector, "IncreaseRate"), Ids.flow_rate_setting)   // aspirate rate
        add(child(injector, "DecreaseRate"), Ids.flow_rate_setting)   // inject rate

        const position = child(fs, "SamplePosition")
        add(position, Ids.autosampler, Ids.tray, Ids.controller)
        add(child(position, "TargetValue"), Ids.position)
        add(child(position, "CurrentValue"), Ids.position)

        add(child(fs, "Valve"), Ids.valve, Ids.controller)

        const dadFn = child(fs, "DAD")
        add(dadFn, Ids.diode_array_detector, Ids.liquid_chromatography_detector)
        for (const ch of ["DAD1A", "DAD1B", "DAD1C", "DAD1D"]) {
            const f = child(dadFn, "FunctionSet", ch)
            AFODictionary.addSensorFunctionReferences(f as any, Ids.chromatographic_detector, Ids.absorbance)
            add(child(f, "SensorValue", "Wavelength"), Ids.detector_wavelength_setting, Ids.wavelength)
        }
        const spectrum = child(dadFn, "FunctionSet", "DAD1I")
        AFODictionary.addSensorFunctionReferences(spectrum as any, Ids.diode_array_detector, Ids.absorption_spectrum)

        // program templates (created before): chromatography methods
        for (const t of (child(unit, "ProgramManager", "ProgramTemplateSet")?.getComponents() ?? []) as UAObject[]) {
            add(t, Ids.LC_UV_system_method, Ids.high_performance_liquid_chromatography)
            if (/gradient/i.test(t.browseName.name ?? "")) add(t, Ids.gradient_profile_setting_of_chromatography)
        }
    }
}

/** a new result: defaults plus chromatography result */
export function addResultReferences(result: LADSResult, gradient: boolean) {
    AFODictionary.addDefaultResultReferences(result)
    add(result as unknown as UAObject, Ids.chromatography_result, Ids.high_performance_liquid_chromatography)
    add(result.programTemplate as unknown as UAObject, Ids.LC_UV_system_method, Ids.high_performance_liquid_chromatography)
    if (gradient) add(result.programTemplate as unknown as UAObject, Ids.gradient_profile_setting_of_chromatography)
}

/** VariableSet entries of one sample: the sample's chromatogram, its peak list and the peak facets */
export function addPeakReferences(sample: UAObject, peaks: UAObject[]) {
    add(sample, Ids.chromatogram, Ids.peak_list)
    peaks.forEach((peak, i) => {
        add(peak, Ids.chromatography_peak)
        add(child(peak, "RetentionTime"), Ids.retention_time)
        add(child(peak, "Height"), Ids.peak_height, Ids.absorbance)
        add(child(peak, "Width"), Ids.peak_width_at_half_height)
        add(child(peak, "Area"), Ids.peak_area)
        add(child(peak, "AbsorptionMaximum"), Ids.wavelength)
        add(child(peak, "Channel"), Ids.detector_identifier)
    })
}
