# LADS Compliance Document Extension — Developer Documentation

**Model URI:** `http://aixengineers.de/LADS-CD/`  
**Version:** `1.00`  
**Publication Date:** `2025-10-20T12:31:32+02:00`  
**Namespace Index:** `1`  
**Supermodel Dependencies:**  
- OPC UA Base Model (`http://opcfoundation.org/UA/`, Version `1.05.03`)  

---

## Index of Defined Types

| Category | BrowseName | NodeId | SuperType |
|-----------|-------------|---------|------------|
| **ObjectType** | [ComplianceDocumentType](#compliancedocumenttype) | ns=1;i=1001 | BaseObjectType |
| **ObjectType** | [ComplianceDocumentSetType](#compliancedocumentsettype) | ns=1;i=1000 | FolderType |
| **ReferenceType** | [HasComplianceDocument](#hascompliancedocument) | ns=1;i=4000 | References |
| **ReferenceType** | [HasCalibrationCertificate](#hascalibrationcertificate) | ns=1;i=4001 | HasComplianceDocument |
| **ReferenceType** | [HasValidationReport](#hasvalidationreport) | ns=1;i=4002 | HasComplianceDocument |
| **ReferenceType** | [HasQualificationProtocol](#hasqualificationprotocol) | ns=1;i=4003 | HasComplianceDocument |

---

## ComplianceDocumentType
**NodeId:** `ns=1;i=1001`  
**SuperType:** `BaseObjectType`  
**Description:**  
Represents a document that provides evidence of compliance with quality, metrological, or regulatory requirements.  
Each instance may reference its digital content and associated format definition.  

| BrowseName | TypeDefinition | DataType | ModellingRule | Description |
|-------------|----------------|-----------|----------------|--------------|
| **DocumentName** | PropertyType | LocalizedText | Mandatory | Human-readable title of the compliance document. |
| **MimeType** | PropertyType | String | Mandatory | Media type identifying the document format (e.g., `application/vnd.ptb.dcc+xml`, `application/pdf`). |
| **IssuedAt** | PropertyType | DateTime | Mandatory | Date and time when the document was issued. |
| **ValidFrom** | PropertyType | DateTime | Optional | Optional date and time when the validity of the document begins (if different from issue date). |
| **ValidUntil** | PropertyType | DateTime | Optional | Optional expiration date indicating when the document is no longer valid. |
| **SchemaUri** | PropertyType | UriString | Optional | URI referencing the schema, manifest, or format definition that describes the document’s semantics. |
| **Content** | BaseDataVariableType | String | Optional | Textual or encoded content of the document (e.g., XML, JSON, or text). Use for smaller documents (<1 MB). |
| **File** | FileType (Object) | — | Optional | Provides access to the document via OPC UA File transfer methods. Recommended for large documents (>1 MB). Only one of `Content` or `File` should be present. |

---

## ComplianceDocumentSetType
**NodeId:** `ns=1;i=1000`  
**SuperType:** `FolderType`  
**Description:**  
A container for all compliance-related documents associated with a Device, Component, or Function.  
Each entry represents a digital document providing evidence of conformity with applicable standards, quality requirements, or regulatory frameworks.  

Typical examples include:  
- Calibration certificates (e.g., PTB Digital Calibration Certificate – DCC)  
- Validation or qualification reports (e.g., IQ/OQ/PQ, CSV, Cleaning Validation)  
- Inspection or test records  
- Accreditation or certification statements  

| BrowseName | TypeDefinition | DataType | ModellingRule | Description |
|-------------|----------------|-----------|----------------|--------------|
| **NodeVersion** | PropertyType | String | Optional | Version of this node definition (e.g., `0`). |
| **&lt;ComplianceDocument&gt;** | ComplianceDocumentType | — | OptionalPlaceholder | Placeholder for contained compliance document instances. |

---

## ReferenceTypes

### HasComplianceDocument
**NodeId:** `ns=1;i=4000`  
**SuperType:** `References`  
**InverseName:** `AppliesTo`  
**Description:**  
Links a Node (e.g., Device, Component, or Function) to a ComplianceDocument that provides regulatory or quality evidence.  

---

### HasCalibrationCertificate
**NodeId:** `ns=1;i=4001`  
**SuperType:** `HasComplianceDocument`  
**InverseName:** `CalibrationAppliesTo`  
**Description:**  
Links a Node to a ComplianceDocument representing a calibration certificate (e.g., DCC XML).  

---

### HasValidationReport
**NodeId:** `ns=1;i=4002`  
**SuperType:** `HasComplianceDocument`  
**InverseName:** `ValidationAppliesTo`  
**Description:**  
Links a Node to a ComplianceDocument representing a validation or qualification report (e.g., IQ/OQ/PQ).  

---

### HasQualificationProtocol
**NodeId:** `ns=1;i=4003`  
**SuperType:** `HasComplianceDocument`  
**InverseName:** `QualificationAppliesTo`  
**Description:**  
Links a Node to a ComplianceDocument representing a qualification or validation protocol (e.g., Cleaning Validation, CSV).  

---

## Example Integration (Developer View)

```
Objects
└─ DeviceSet
└─ Balance_224G372 (DeviceType)
└─ ComplianceDocumentSet
├─ DCC_224G372 (ComplianceDocumentType)
│   ├─ DocumentName = “Digital Calibration Certificate 224G372”
│   ├─ MimeType = “application/vnd.ptb.dcc+xml”
│   ├─ IssuedAt = 2025-05-12
│   ├─ ValidFrom = 2025-05-12
│   ├─ ValidUntil = 2026-05-12
│   ├─ SchemaUri = “https://ptb.de/dcc/schema/3.3.0”
│   └─ Content = “dcc:digitalCalibrationCertificate…”
└─ CleaningValidation_2025Q1 (ComplianceDocumentType)
├─ DocumentName = “Cleaning Validation Report Q1/2025”
├─ MimeType = “application/pdf”
└─ File (FileType)
```
---

## Recommended MIME Types

| Document Type | MIME Type | Comment |
|----------------|------------|----------|
| PTB Digital Calibration Certificate (DCC) | `application/vnd.ptb.dcc+xml` | Structured XML according to PTB schema |
| Allotrope Simple Model (ASM) | `application/vnd.allotrope.simple+json` *(proposed)* | JSON-based scientific record |
| Portable Document Format (PDF) | `application/pdf` | Printable certificates and reports |
| Comma-Separated Values (CSV) | `text/csv; charset=utf-8` | Tabular data or results |
| Plain Text (ASCII/UTF-8) | `text/plain; charset=utf-8` | Generic textual content |
| Markdown Documentation | `text/markdown; charset=utf-8` | Human-readable structured text |
| XML (generic) | `application/xml` | Generic XML data |
| JSON (generic) | `application/json` | Generic JSON structure |

---

## Notes and Recommendations

- **Consistency:** All descriptive attributes use `PropertyType`; the main payload (`Content`) uses `BaseDataVariableType` to represent the actual document data.  
- **Optional File Interface:** For large or binary documents, expose the OPC UA `FileType` object instead of storing content inline.  
- **Extensibility:** Custom ReferenceTypes (`HasCalibrationCertificate`, `HasValidationReport`, etc.) allow semantic linking to device components.  
- **Naming conventions:** Aligned with DI/LADS pattern (`…SetType`, `Has…`, placeholder syntax).  
- **Character encoding:** For `String`-based `Content`, use UTF-8 by default unless otherwise specified in `MimeType`.

---

## Change Log

| Version | Date | Description |
|----------|------|--------------|
| **1.00** | 2025-10-20 | Initial release of LADS Compliance Document extension. Introduces `ComplianceDocumentType`, `ComplianceDocumentSetType`, and specialized reference types. Corrected `ValidFrom`/`ValidUntil` property names. |

---
