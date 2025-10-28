// SPDX-FileCopyrightText: 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
// SPDX-License-Identifier: MIT

/**
 *
 * Copyright (c) 2025 Dr. Matthias Arnold, AixEngineers, Aachen, Germany.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { DataType, DateTime, LocalizedText, UABaseDataVariable, UAFile, UAFolder, UAObject, UAProperty,  } from "node-opcua";

export interface LADSComplianceDocumentSet extends UAFolder {}

export interface LADSComplianceFile extends UAFile {
    fileName?: UAProperty<string, DataType.String>
}

export interface LADSComplianceDocument extends UAObject {
    documentName: UAProperty<LocalizedText, DataType.LocalizedText>
    content?: UABaseDataVariable<string, DataType.String>
    file?: LADSComplianceFile
    mimeType: UAProperty<string, DataType.String>
    schemaUri?: UAProperty<string, DataType.String>
    issuedAt: UAProperty<DateTime, DataType.DateTime>
    validFrom?: UAProperty<DateTime, DataType.DateTime>
    validUntil?: UAProperty<DateTime, DataType.DateTime>
}
