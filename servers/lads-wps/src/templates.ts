//---------------------------------------------------------------
// program templates

import { LADSProgramTemplate } from "@interfaces"

//---------------------------------------------------------------
export interface WpsProgramTemplate {
    name: string,
    description?: string,
    component?: string
    steps: WpsProgramTemplateStep[]
}

export interface WpsProgramTemplateStep {
    name: string,
    duration?: number
    confirmation?: boolean
}

export const DispenseId = "Dispense"

export const ProgramTemplateDispense: WpsProgramTemplate = {
    name: DispenseId,
    description: "Dispense based on current mode and set-points",
    steps: [{ name: "Dispense", duration: 600000 }]
}

export const ProgramTemplateSanitization: WpsProgramTemplate = {
    name: "Sanitization",
    steps: [
        { name: "Disconnect the feed-water hose from the device", confirmation: true },
        { name: "Disconnect endfilter and connect dispense tube at dispenser", confirmation: true },
        { name: "Guide dispense tube to waste", confirmation: true },
        { name: "Inject sanitization fluid acccording to the instructions", confirmation: true },
        { name: "Reconnect the feed-water hose to the device", confirmation: true },
        { name: "Start sanitization", duration: 120000 },
        { name: "Disconnect dispense tube and install endfilter according to the instructions", confirmation: true },
    ]
}

export const ProgramTemplateReplaceCartridge: WpsProgramTemplate = {
    name: "Replace Cartridge",
    component: "Cartridge",
    steps: [
        { name: "Disconnect the feed-water hose from the device", confirmation: true },
        { name: "Collect the water exiting from the outlet in a container (1 L) and start depressurization.", confirmation: true },
        { name: "Depressurization 0.5 min", duration: 30000 },
        { name: "Replace cartridges according to the instructions", confirmation: true },
        { name: "Start the flushing process", confirmation: true },
        { name: "Flushing 2min", duration: 120000 },
    ]
}

export const ProgramTemplateReplaceEndfilter: WpsProgramTemplate = {
    name: "Replace Endfilter",
    component: "Endfilter",
    steps: [
        { name: "Replace endfilter according to the instructions", confirmation: true },
    ]
}

export const ProgramTemplateReplaceUVLamp: WpsProgramTemplate = {
    name: "Replace UV Lamp",
    component: "UVLamp",
    steps: [
        { name: "Replace UV Lamp according to the instructions", confirmation: true },
    ]
}

export const ProgramTemplateDepressurization: WpsProgramTemplate = {
    name: "Depressurization",
    steps: [
        { name: "Disconnect the feed-water hose from the device", confirmation: true },
        { name: "Collect the water exiting from the outlet in a container (1 L) and start depressurization.", confirmation: true },
        { name: "Depressurization 0.5 min", duration: 30000 },
        { name: "Switch off the device", confirmation: true },
    ]
}

export const ProgramTemplateFlushTOC: WpsProgramTemplate = {
    name: "Flush TOC",
    steps: [
        { name: "Flushing 5min", duration: 300000 },
    ]
}

export interface ProgramTemplateTuple {
    template: WpsProgramTemplate
    node: LADSProgramTemplate
}
