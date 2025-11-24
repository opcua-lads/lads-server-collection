# LADS-CD Companion Specification
**Namespace URI:** `http://aixengineers.de/LADS-CD/`  
**Version:** 1.0  
**Document type:** Developer Reference (Compact)

---

## 1. Overview

The **LADS-CD** (Compliance Documentation) information model standardizes how OPC UA servers expose and link compliance-relevant documents such as:

- Calibration certificates  
- IQ / OQ / PQ qualification protocols  
- Validation reports  
- Declarations of Conformity  

It provides:
1. ObjectTypes for representing individual compliance documents and sets of such documents.
2. ReferenceTypes for linking those documents to devices, subsystems, or methods in the address space.

---

## 2. Namespace

| Prefix    | URI                                   |
|-----------|---------------------------------------|
| `LADS-CD` | `http://aixengineers.de/LADS-CD/`     |

---

## 3. ObjectTypes

### 3.1 `ComplianceDocumentSetType`
**NodeClass:** ObjectType  
**IsAbstract:** false  

**Description:**  
A container for all compliance-related documents associated with an asset.  
Used to group multiple instances of `ComplianceDocumentType`.  
Provides a `NodeVersion` property for change tracking.

#### Components / Properties

| BrowseName              | TypeDefinition          | DataType   | Modeling Rule | Description |
|-------------------------|-------------------------|------------|---------------|-------------|
| `NodeVersion`           | `PropertyType`          | `String`   | Optional      | Version string for this set, allowing clients to detect changes to the set contents. |
| `<ComplianceDocument>`  | `ComplianceDocumentType`| —          | Optional      | Placeholder/component for one or more compliance document instances under the set. |

> If you have an instrument, subsystem, or method and you want to present “all its compliance evidence,” you instantiate an Object of this type and populate it with `ComplianceDocumentType` instances.

---

### 3.2 `ComplianceDocumentType`
**NodeClass:** ObjectType  
**IsAbstract:** false  
**Purpose:**  
Represents a single compliance document: e.g. a calibration certificate, an OQ protocol, a PQ protocol, a validation report, or a declaration of conformity.

The document content can be provided:
- inline in `Content`, or
- via an OPC UA `FileType` node (`File`).

Metadata such as issuance date, validity, and MIME type are modeled as Properties.

#### Components / Properties (from nodeset, with exact ModelingRules)

| BrowseName      | TypeDefinition            | DataType        | Modeling Rule | Description |
|-----------------|---------------------------|-----------------|---------------|-------------|
| `Content`       | `BaseDataVariableType`    | `String`        | Optional      | Binary representation of the document content (e.g. XML, JSON, PDF bytes). Intended for smaller documents (typically < 1 MB). If the `File` Object is provided, this Variable may be omitted. |
| `IssuedAt`      | `PropertyType`            | `DateTime`      | Mandatory     | Date and time when the document was issued. |
| `ValidFrom`     | `PropertyType`            | `DateTime`      | Optional      | Start of the validity period for this document. |
| `ValidUntil`    | `PropertyType`            | `DateTime`      | Optional      | End/expiry of the validity period for this document. |
| `File`          | `FileType`                | —               | Optional      | File node (OPC UA `FileType`) providing streamed/binary access to the full document (e.g. PDF). If `Content` is provided inline, `File` may be omitted. |
| `MimeType`      | `PropertyType`            | `String`        | Optional      | IANA media type of the document content (e.g. `application/pdf`, `application/json`). |
| `DocumentName`  | `PropertyType`            | `LocalizedText` | Mandatory     | Human-readable title / name of the document (e.g. “Calibration Certificate 2025-03-14”, “OQ Protocol v2.1”). |
| `SchemaUri`     | `PropertyType`            | `UriString`     | Optional      | URI identifying the machine-readable schema / structure of the content. Allows clients to interpret structured payloads (XML/JSON/etc.). |

**Important behavioural notes:**
- `Content` vs `File`:  
  The model allows either inline payload (`Content`) or an external file (`File`). Servers SHOULD provide at least one of them.  
- `IssuedAt` and `DocumentName` are modeled with a `HasModellingRule` reference to the **Mandatory** ModelingRule (NodeId `i=78`).  
  Therefore: every instance of `ComplianceDocumentType` **shall** provide them.  
- Other children use `HasModellingRule` → `Optional` (NodeId `i=80`), meaning they may be omitted if not applicable (for example `ValidUntil` may not exist for perpetual documents).

---

## 4. ReferenceTypes

The model defines semantic ReferenceTypes that link assets to the relevant compliance documents.

All custom ReferenceTypes are subtypes of the standard `NonHierarchicalReferences` ReferenceType.  
They are intended to be browsed **forward** from the subject (device, subsystem, method, etc.) to a `ComplianceDocumentType` instance.

### 4.1 Summary Table

| BrowseName                              | Subtype Of                    | Description |
|-----------------------------------------|-------------------------------|-------------|
| `HasComplianceDocument`                 | `NonHierarchicalReferences`   | Generic link between any node and a compliance document (`ComplianceDocumentType`). Use this if no more specific semantic fits. |
| `HasCalibrationCertificate`             | `HasComplianceDocument`       | Links to a calibration certificate for traceability of measurement performance / metrological compliance. |
| `HasCalibrationReport`                  | `HasComplianceDocument`       | Links to a calibration report or calibration log that is not the formal certificate (evidence of procedure/results). |
| `HasValidationReport`                   | `HasComplianceDocument`       | Links to a validation report demonstrating method validation, system validation, or regulatory suitability. |
| `HasQualificationProtocol`              | `HasComplianceDocument`       | Generic link to a qualification protocol. Serves as the parent for IQ / OQ / PQ specific references. |
| `HasInstallationQualificationProtocol`  | `HasQualificationProtocol`    | Links specifically to an Installation Qualification (IQ) protocol. |
| `HasOperationQualificationProtocol`     | `HasQualificationProtocol`    | Links specifically to an Operational Qualification (OQ) protocol. |
| `HasProcessQualificationProtocol`       | `HasQualificationProtocol`    | Links specifically to a Process / Performance Qualification (PQ) protocol. |
| `HasDeclarationOfConformity`            | `HasComplianceDocument`       | Links to a Declaration of Conformity (e.g. CE DoC for regulatory compliance). |

**Why all of them are non-hierarchical:**  
These relationships do **not** imply physical composition or ownership. They are semantic associations:  
“this device is covered by that calibration cert,”  
“this method is qualified by that OQ protocol,” etc.

---

## 5. Usage Pattern

1. Under the device (or subsystem / method) create an Object of `ComplianceDocumentSetType`.  
2. For each real-world document, create an Object of `ComplianceDocumentType` with at least:
   - `DocumentName` (Mandatory),
   - `IssuedAt` (Mandatory),
   - plus either `Content` or `File`.
3. Link the device/subsystem/method to the specific document instance using the most specific ReferenceType:
   - `HasCalibrationCertificate`
   - `HasOperationQualificationProtocol`
   - `HasDeclarationOfConformity`
   - etc.

Because these ReferenceTypes are all subtypes of `NonHierarchicalReferences`, you don’t disturb your existing functional or device hierarchy: you just add traceable compliance links.

---

## 6. Example Structure

```text
+ Device (MyAnalyzer)
  ├─ ComplianceDocuments : Object (ComplianceDocumentSetType)
  │   ├─ CalibrationCert_2025 : Object (ComplianceDocumentType)
  │   │   ├─ DocumentName  (PropertyType, LocalizedText)  [Mandatory]
  │   │   ├─ IssuedAt      (PropertyType, DateTime)       [Mandatory]
  │   │   ├─ ValidFrom     (PropertyType, DateTime)       [Optional]
  │   │   ├─ ValidUntil    (PropertyType, DateTime)       [Optional]
  │   │   ├─ MimeType      (PropertyType, String)         [Optional]
  │   │   ├─ SchemaUri     (PropertyType, UriString)      [Optional]
  │   │   ├─ Content       (BaseDataVariableType, String) [Optional]
  │   │   └─ File          (FileType)                     [Optional]
  │   └─ OQ_Protocol_2025 : Object (ComplianceDocumentType)
  │       └─ ...
  └─► HasCalibrationCertificate
        ↳ CalibrationCert_2025

  └─► HasOperationQualificationProtocol
        ↳ OQ_Protocol_2025

  └─► HasDeclarationOfConformity
        ↳ DoC_CE