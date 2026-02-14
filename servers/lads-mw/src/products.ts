// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: AGPL 3

/*
LADS Microwave Density & Moisture Analyzer
Copyright (C) 2026  Dr. Matthias Arnold, AixEngineers, Aachen, Germany.

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

//---------------------------------------------------------------
// functional unit implementation
//---------------------------------------------------------------
import { setNumericValue, setStringValue, getStringValue, getNumericValue } from "@utils"
import EventEmitter from "events"
import { UAVariable } from "node-opcua"
import { getMWNameSpace } from "./device"
import { Product, ProductSet } from "./interfaces"

export interface ProductOptions {
    name: string,
    densityOffset?: number,
    densityLowLimit?: number,
    densityHighLimit?: number,
    moistureOffset?: number,
    moistureLowLimit?: number,
    moistureHighLimit?: number,
    temperatureLowLimit?: number,
    temperatureHighLimit?: number,
    samples?: number,
}

export const Products: ProductOptions[] = [
    {
        name: "Tabacco",
        densityLowLimit: 0.5,
        densityHighLimit: 0.7,
        moistureLowLimit: 30,
        moistureHighLimit: 40,
        temperatureLowLimit: 20,
        temperatureHighLimit: 25,
    },
    {
        name: "Robusta",
        densityLowLimit: 0.6,
        densityHighLimit: 0.8,
        moistureLowLimit: 20,
        moistureHighLimit: 30,
        temperatureLowLimit: 18,
        temperatureHighLimit: 27,
    },
    {
        name: "Green Tea",
        densityLowLimit: 0.25,
        densityHighLimit: 0.35,
        moistureLowLimit: 25,
        moistureHighLimit: 35,
        temperatureLowLimit: 18,
        temperatureHighLimit: 23,
    },
]

function initNumericProperty(property: UAVariable, value: number | undefined) {
    if (!value) return
    setNumericValue(property, value)
}

export class ProductImpl extends EventEmitter {
    product: Product
    constructor(parent: ProductSet, options: ProductOptions) {
        super()
        const productType = getMWNameSpace(parent.addressSpace).findObjectType("ProductType")
        const product = productType.instantiate({
            componentOf: parent,
            browseName: options.name
        }) as Product
        this.product = product
        setStringValue(product.name, options.name)
        initNumericProperty(product.densityOffset, options.densityOffset)
        initNumericProperty(product.densityLowLimit, options.densityLowLimit)
        initNumericProperty(product.densityHighLimit, options.densityHighLimit)
        initNumericProperty(product.moistureOffset, options.moistureOffset)
        initNumericProperty(product.moistureLowLimit, options.moistureLowLimit)
        initNumericProperty(product.moistureHighLimit, options.moistureHighLimit)
        initNumericProperty(product.temperatureLowLimit, options.temperatureLowLimit)
        initNumericProperty(product.temperatureHighLimit, options.temperatureHighLimit)
        initNumericProperty(product.sampleCount, options.samples)
    }

    get name(): string { return getStringValue(this.product.name) }
    get densityOffset(): number { return getNumericValue(this.product.densityOffset) }
    get densityLowLimit(): number { return getNumericValue(this.product.densityLowLimit) }
    get densityHighLimit(): number { return getNumericValue(this.product.densityHighLimit) }
    get moistureOffset(): number { return getNumericValue(this.product.moistureOffset) }
    get moistureLowLimit(): number { return getNumericValue(this.product.moistureLowLimit) }
    get moistureHighLimit(): number { return getNumericValue(this.product.moistureHighLimit) }
    get temperatureLowLimit(): number { return getNumericValue(this.product.temperatureLowLimit) }
    get temperatureHighLimit(): number { return getNumericValue(this.product.temperatureHighLimit) }
    get samples(): number { return getNumericValue(this.product.sampleCount) }
}

export class ProductSetImpl {
    productSet: ProductSet
    products: ProductImpl[] = []

    constructor(productSet: ProductSet, options: ProductOptions[]) {
        this.productSet = productSet
        options.forEach((productOptions) => {
            const product = new ProductImpl(productSet, productOptions)
            this.products.push(product)
        })
    }

    get productNames(): string[] { return this.products.map(product => product.name) }
    findProduct(name: string): ProductImpl | undefined { return this.products.find(product => product.name == name) }
}

