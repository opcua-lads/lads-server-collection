import { ControllerOptions } from "./server"
import { ViscometerUnitImpl } from "./unit"

//---------------------------------------------------------------
// abstract controller-device implementation
//---------------------------------------------------------------
export abstract class ControllerImpl {
    parent: ViscometerUnitImpl
    options: ControllerOptions

    constructor(parent: ViscometerUnitImpl, options: ControllerOptions) {
        this.parent = parent
        this.options = options
    }

    abstract start(): void;
    abstract stop(): void;
}

