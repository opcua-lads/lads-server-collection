// SPDX-FileCopyrightText: 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2026 - 2026 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { DataType, Variant, StatusCodes, UAVariable, UAObject, DataValue, NodeIdLike, resolveNodeId } from "node-opcua";
import { promises as fsp } from "fs"
import fs from "fs"
import path from "path";
import { UADevice } from "node-opcua-nodeset-di";

function imageDataTypeFromExtension(fileName: string): NodeIdLike {
    const ext = path.extname(fileName).toLowerCase();

    switch (ext) {
        case ".bmp":
            return resolveNodeId("ImageBMP");

        case ".gif":
            return resolveNodeId("ImageGIF");

        case ".jpg":
        case ".jpeg":
            return resolveNodeId("ImageJPG");

        case ".png":
            return resolveNodeId("ImagePNG");

        default:
            // Use ByteString as generic fallback.
            return DataType.ByteString;
    }
}

export interface DeviceTypeImageOptions {
    parent: UADevice
    imagesDir: string
    imageFiles?: string[]
}

/**
 * Adds image files as read-only ByteString variables below DeviceTypeImages.
 */
export class DeviceTypeImage {

    static create(options: DeviceTypeImageOptions) { new DeviceTypeImage(options) }

    public readonly variables = new Map<string, UAVariable>();
    private readonly cache = new Map<string, Buffer>();

    constructor(options: DeviceTypeImageOptions) {
        const folderName = "DeviceTypeImage"
        const folder = <UAObject>options.parent.getChildByName(folderName)
        if (!folder) {
            console.debug(`${folderName} not found.`)
            return
        }
        if (!options.imageFiles || options.imageFiles.length === 0) {
            options.imageFiles = scanImageDir(options.imagesDir)
        }
        options.imageFiles.forEach(fileName => this.addImageVariable(folder, options.imagesDir, fileName))
    }

    private addImageVariable(parent: UAObject, resourcesDir: string, fileName: string): void {
        const browseName = this.toBrowseName(fileName);
        const absolutePath = path.resolve(resourcesDir, fileName);
        const imageDataType = imageDataTypeFromExtension(fileName);

        const variable = parent.namespace.addVariable({
            componentOf: parent,
            browseName: browseName,
            displayName: fileName,
            dataType: imageDataType,
            accessLevel: "CurrentRead",
            userAccessLevel: "CurrentRead",

            value: {
                refreshFunc: async (callback) => {
                    try {
                        let data = this.cache.get(absolutePath);
                        if (!data) {
                            data = await fsp.readFile(absolutePath);
                            this.cache.set(absolutePath, data);
                        }
                        callback(null, new DataValue({
                            value: new Variant({
                                dataType: DataType.ByteString,
                                value: data,
                            }),
                            statusCode: StatusCodes.Good,
                            sourceTimestamp: new Date(),
                        }));
                    } catch (err) {
                        callback(null, new DataValue({
                            value: new Variant({
                                dataType: DataType.ByteString,
                                value: Buffer.alloc(0),
                            }),
                            statusCode: StatusCodes.BadResourceUnavailable,
                            sourceTimestamp: new Date(),
                        }));
                    }
                },
            },
        });

        this.variables.set(fileName, variable);
    }

    private toBrowseName(fileName: string): string {
        const parsed = path.parse(fileName);
        return parsed.name
            .replace(/[^A-Za-z0-9_]/g, "_")
            .replace(/^[^A-Za-z_]/, "_$&");
    }
}

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
    ".bmp",
    ".gif",
    ".jpg",
    ".jpeg",
    ".png",
]);

function scanImageDir(resourcesDir: string): string[] {
    try {
        return fs
            .readdirSync(resourcesDir, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .filter((fileName) => SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
            .sort((a, b) => a.localeCompare(b));
    }
    catch (error) {
        console.debug("Unable to load images:", error)
        return []
    }
}

