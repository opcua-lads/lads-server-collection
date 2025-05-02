import * as fs from 'fs';
import * as path from 'path';
import csv from 'csv-parser';
import { create } from 'xmlbuilder2';

// Define the interface for a dictionary entry based on the CSV structure.
interface DictionaryEntry {
    termIRI: string;
    prefLabel: string;
    altLabels?: string;
    domain?: string;
    termType?: string;
    definition?: string;
    scopeNote?: string;
    sources: string[];
    examples?: string;
    parents?: string;
}

/**
 * Parses the CSV file and aggregates rows based on the unique identifier (TermIRI).
 * Multiple rows with the same TermIRI will have their Source values merged.
 *
 * @param filePath - The full path to the CSV file.
 * @returns A promise that resolves to an array of DictionaryEntry objects.
 */
function parseDictionaryCSV(filePath: string): Promise<DictionaryEntry[]> {
    return new Promise((resolve, reject) => {
        // Use a Map to merge entries sharing the same TermIRI.
        const entriesMap = new Map<string, DictionaryEntry>();

        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                // Extract and trim each field from the CSV row.
                const termIRI = row['TermIRI'] ? row['TermIRI'].trim() : '';
                if (!termIRI) return; // Skip rows without a unique identifier.

                const prefLabel = row['PrefLabel'] ? row['PrefLabel'].trim() : '';
                const altLabels = row['AltLabels'] ? row['AltLabels'].trim() : '';
                const domain = row['Domain'] ? row['Domain'].trim() : '';
                const termType = row['TermType'] ? row['TermType'].trim() : '';
                const definition = row['Definition'] ? row['Definition'].trim() : '';
                const scopeNote = row['ScopeNote'] ? row['ScopeNote'].trim() : '';
                const source = row['Source'] ? row['Source'].trim() : '';
                const examples = row['Examples'] ? row['Examples'].trim() : '';
                const parents = row['Parents'] ? row['Parents'].trim() : '';

                // If an entry with this TermIRI already exists, aggregate the source.
                if (entriesMap.has(termIRI)) {
                    const existingEntry = entriesMap.get(termIRI)!;
                    if (source && !existingEntry.sources.includes(source)) {
                        existingEntry.sources.push(source);
                    }
                } else {
                    // Create a new entry for this TermIRI.
                    const newEntry: DictionaryEntry = {
                        termIRI,
                        prefLabel,
                        altLabels,
                        domain,
                        termType,
                        definition,
                        scopeNote,
                        sources: source ? [source] : [],
                        examples,
                        parents,
                    };
                    entriesMap.set(termIRI, newEntry);
                }
            })
            .on('end', () => {
                resolve(Array.from(entriesMap.values()));
            })
            .on('error', (err) => reject(err));
    });
}

// Example usage: Read the CSV file, build the object structure, and log the results.
async function importCSV(csvFilePath: string): Promise<DictionaryEntry[]> {
    // Adjust the path to point to your CSV file.
    // const csvFilePath = path.resolve('./src/lads-afo', 'AFO_Dictionary-2024_12.csv')

    try {
        const dictionaryEntries = await parseDictionaryCSV(csvFilePath);
        console.log('Parsed dictionary entries:');
        console.log(JSON.stringify(dictionaryEntries, null, 2));
        return dictionaryEntries
    } catch (error) {
        console.error('Error parsing CSV file:', error);
        return []
    }
}



// The DictionaryEntry interface as defined from the CSV.
/**
 * Extracts the identifier portion from a termIRI.
 * If a '#' is present, the substring following the last '#' is returned.
 * Otherwise, the last path segment after '/' is returned.
 *
 * @param termIRI The termIRI string.
 * @returns The extracted identifier.
 */
function extractId(termIRI: string): string {
    if (termIRI.includes('#')) {
        return termIRI.substring(termIRI.lastIndexOf('#') + 1);
    } else {
        const parts = termIRI.split('/');
        return parts[parts.length - 1];
    }
}

/**
 * Constructs the SymbolicName for a dictionary entry.
 * In this example, we prepend a fixed prefix and replace any '#' characters with underscores.
 *
 * @param termIRI The termIRI of the entry.
 * @returns The constructed SymbolicName.
 */
function getSymbolicName(termIRI: string): string {
    const idPart = extractId(termIRI).replace(/#/g, '_');
    return idPart;
}

/**
 * Constructs the Description text for a dictionary entry.
 * Format:
 *   <termIRI>
 *   <SymbolicName>, (<optional altLabels>): <definition>
 *   [ <optional list of sources>]
 *
 * @param entry The dictionary entry.
 * @param symbolicName The computed symbolic name.
 * @returns The description string.
 */
function buildDescription(entry: DictionaryEntry, symbolicName: string): string {
    let desc = entry.termIRI + "\n" + symbolicName;
    if (entry.altLabels && entry.altLabels.trim() !== "") {
        desc += ", (" + entry.altLabels.trim() + ")";
    }
    if (entry.definition && entry.definition.trim() !== "") {
        desc += ": " + entry.definition.trim();
    }
    if (entry.sources && entry.sources.length > 0 && entry.sources.some(s => s.trim() !== "")) {
        desc += "\n[ " + entry.sources.filter(s => s.trim() !== "").join(", ") + " ]";
    }
    return desc;
}

/**
 * Appends several Namespace-related UAVariable elements to the provided parent XML element.
 *
 * @param parent The xmlbuilder2 XML element to which the variables will be appended.
 */
function addNamespaceVariables(parent: any, namespaceUri: string, namespacePublicationDate: string, namespaceVersion: string): void {
    // UAVariable for IsNamespaceSubset
    parent
      .ele('UAVariable', {
        DataType: "Boolean",
        NodeId: "ns=1;i=1001",
        BrowseName: "IsNamespaceSubset",
        ParentNodeId: "ns=1;i=1000"
      })
        .ele('DisplayName').txt("IsNamespaceSubset").up()
        .ele('Description').txt("If TRUE then the server only supports a subset of the namespace.").up()
        .ele('References')
          .ele('Reference', { ReferenceType: "HasProperty", IsForward: "false" }).txt("ns=1;i=1000").up()
          .ele('Reference', { ReferenceType: "HasTypeDefinition" }).txt("i=68").up()
        .up() // References
      .up(); // UAVariable
  
    // UAVariable for NamespacePublicationDate
    parent
      .ele('UAVariable', {
        DataType: "DateTime",
        NodeId: "ns=1;i=1002",
        BrowseName: "NamespacePublicationDate",
        ParentNodeId: "ns=1;i=1000"
      })
        .ele('DisplayName').txt("NamespacePublicationDate").up()
        .ele('Description').txt("The publication date for the namespace.").up()
        .ele('References')
          .ele('Reference', { ReferenceType: "HasProperty", IsForward: "false" }).txt("ns=1;i=1000").up()
          .ele('Reference', { ReferenceType: "HasTypeDefinition" }).txt("i=68").up()
        .up() // References
        .ele('Value')
          .ele('uax:DateTime').txt(namespacePublicationDate).up()
        .up() // Value
      .up(); // UAVariable
  
    // UAVariable for NamespaceUri
    parent
      .ele('UAVariable', {
        DataType: "String",
        NodeId: "ns=1;i=1003",
        BrowseName: "NamespaceUri",
        ParentNodeId: "ns=1;i=1000"
      })
        .ele('DisplayName').txt("NamespaceUri").up()
        .ele('Description').txt("The URI of the namespace.").up()
        .ele('References')
          .ele('Reference', { ReferenceType: "HasProperty", IsForward: "false" }).txt("ns=1;i=1000").up()
          .ele('Reference', { ReferenceType: "HasTypeDefinition" }).txt("i=68").up()
        .up() // References
        .ele('Value')
          .ele('uax:String').txt(namespaceUri).up()
        .up() // Value
      .up(); // UAVariable
  
    // UAVariable for NamespaceVersion
    parent
      .ele('UAVariable', {
        DataType: "String",
        NodeId: "ns=1;i=1004",
        BrowseName: "NamespaceVersion",
        ParentNodeId: "ns=1;i=1000"
      })
        .ele('DisplayName').txt("NamespaceVersion").up()
        .ele('Description').txt("The human readable string representing version of the namespace.").up()
        .ele('References')
          .ele('Reference', { ReferenceType: "HasProperty", IsForward: "false" }).txt("ns=1;i=1000").up()
          .ele('Reference', { ReferenceType: "HasTypeDefinition" }).txt("i=68").up()
        .up() // References
        .ele('Value')
          .ele('uax:String').txt(namespaceVersion).up()
        .up() // Value
      .up(); // UAVariable
  
    // UAVariable for StaticNodeIdTypes
    parent
      .ele('UAVariable', {
        DataType: "i=256",
        ValueRank: "1",
        NodeId: "ns=1;i=1005",
        BrowseName: "StaticNodeIdTypes",
        ParentNodeId: "ns=1;i=1000"
      })
        .ele('DisplayName').txt("StaticNodeIdTypes").up()
        .ele('Description').txt("A list of IdTypes for nodes which are the same in every server that exposes them.").up()
        .ele('References')
          .ele('Reference', { ReferenceType: "HasProperty", IsForward: "false" }).txt("ns=1;i=1000").up()
          .ele('Reference', { ReferenceType: "HasTypeDefinition" }).txt("i=68").up()
        .up() // References
      .up(); // UAVariable
  
    // UAVariable for StaticNumericNodeIdRange
    parent
      .ele('UAVariable', {
        DataType: "i=291",
        ValueRank: "1",
        NodeId: "ns=1;i=1006",
        BrowseName: "StaticNumericNodeIdRange",
        ParentNodeId: "ns=1;i=1000"
      })
        .ele('DisplayName').txt("StaticNumericNodeIdRange").up()
        .ele('Description').txt("A list of ranges for numeric node ids which are the same in every server that exposes them.").up()
        .ele('References')
          .ele('Reference', { ReferenceType: "HasProperty", IsForward: "false" }).txt("ns=1;i=1000").up()
          .ele('Reference', { ReferenceType: "HasTypeDefinition" }).txt("i=68").up()
        .up() // References
      .up(); // UAVariable
  
    // UAVariable for StaticStringNodeIdPattern
    parent
      .ele('UAVariable', {
        DataType: "String",
        NodeId: "ns=1;i=1007",
        BrowseName: "StaticStringNodeIdPattern",
        ParentNodeId: "ns=1;i=1000"
      })
        .ele('DisplayName').txt("StaticStringNodeIdPattern").up()
        .ele('Description').txt("A regular expression which matches string node ids are the same in every server that exposes them.").up()
        .ele('References')
          .ele('Reference', { ReferenceType: "HasProperty", IsForward: "false" }).txt("ns=1;i=1000").up()
          .ele('Reference', { ReferenceType: "HasTypeDefinition" }).txt("i=68").up()
        .up() // References
      .up(); // UAVariable
  }
  

/**
 * Generates an OPC UA NodeSet2 XML document for the given dictionary entries.
 * Each entry is represented as a UAObject that matches the required pattern.
 *
 * @param entries An array of DictionaryEntry objects.
 * @returns A formatted XML string.
 */
function generateNodeset2XML(entries: DictionaryEntry[]): string {
    // Create the XML root element.
    const root = create({ version: '1.0', encoding: 'utf-8' })
        .ele('UANodeSet', {
            LastModified: new Date().toISOString(),
            xmlns: 'http://opcfoundation.org/UA/2011/03/UANodeset.xsd',
            'xmlns:uax': 'http://opcfoundation.org/UA/2008/02/Types.xsd'
        });

    // (Optional) Add NamespaceUris, Models, and Aliases.
    const namespaceUri = 'http://aixengineers.de/UA/Dictionary/AFO'
    const namespaceVersion = '1.0.0'
    const namespacePublicationDate =  new Date().toISOString().split('T')[0] + 'T00:00:00Z'
    const nsUris = root.ele('NamespaceUris');
    nsUris.ele('Uri').txt(namespaceUri);
    const models = root.ele('Models');
    const model = models.ele('Model', {
        ModelUri: namespaceUri,
        PublicationDate: namespacePublicationDate,
        Version: namespaceVersion
    });
    model.ele('RequiredModel', {
        ModelUri: 'http://opcfoundation.org/UA/',
        PublicationDate: '2022-06-28T00:00:00Z',
        Version: '1.05.02'
    });
    const aliases = root.ele('Aliases');
    aliases.ele('Alias', { Alias: 'Boolean' }).txt('i=1');
    aliases.ele('Alias', { Alias: 'DateTime' }).txt('i=13');
    aliases.ele('Alias', { Alias: 'String' }).txt('i=12');
    aliases.ele('Alias', { Alias: 'HasComponent' }).txt('i=47');
    aliases.ele('Alias', { Alias: 'HasProperty' }).txt('i=46');
    aliases.ele('Alias', { Alias: 'HasTypeDefinition' }).txt('i=40');

    // Insert namespace attributes
    const dictionaryNamespaceObject = root.ele('UAObject', {
        SymbolicName: namespaceUri.replace(/[:\/]/g, '_'),
        NodeId: "ns=1;i=1000",
        BrowseName: `1:${namespaceUri}`,
        ParentNodeId: "i=11715"
    })
    const dictionaryNamespaceObjectRefs = dictionaryNamespaceObject.ele('References');
    dictionaryNamespaceObjectRefs.ele('Reference', { ReferenceType: "HasComponent", IsForward: "false" }).txt("i=11715");
    dictionaryNamespaceObjectRefs.ele('Reference', { ReferenceType: "HasTypeDefinition" }).txt("i=11616");    
    addNamespaceVariables(root, namespaceUri,namespacePublicationDate, namespaceVersion)

    // Insert the custom AFO Dictionary UAObject.
    const afoNodeId = false?"ns=1;s=AFO_Dictionary":"ns=1;i=1100";
    const afoObject = root.ele('UAObject', {
        SymbolicName: "AFO_Dictionary",
        NodeId: afoNodeId,
        BrowseName: "1:AFO Dictionary",
        ParentNodeId: "i=17594"
    });
    afoObject.ele('DisplayName').txt("AFO Dictionary");
    afoObject.ele('Description').txt("Allotrope Foundation Ontology Dictionary");
    const afoRefs = afoObject.ele('References');
    afoRefs.ele('Reference', { ReferenceType: "HasComponent", IsForward: "false" }).txt("i=17594");
    afoRefs.ele('Reference', { ReferenceType: "HasTypeDefinition" }).txt("i=17591");

    // For each dictionary entry, create a UAObject node using the AFO Dictionary as the parent.
    entries.forEach((entry, index) => {
        const symbolicName = getSymbolicName(entry.termIRI);
        // NodeId is set to the termIRI.
        const nodeId = false?`ns=1;i=${2000 + index}`:`ns=1;s=${entry.termIRI}`;
        // BrowseName is now "1:<termIRI>".
        const browseName = true?`1:${symbolicName}`:`1:${entry.termIRI}`;
        const description = true?entry.termIRI:buildDescription(entry, symbolicName);
    
        const entryNode = root.ele('UAObject', {
            SymbolicName: symbolicName,
            NodeId: nodeId,
            BrowseName: browseName,
            ParentNodeId: afoNodeId  // Use the AFO Dictionary as the parent.
        });
        entryNode.ele('DisplayName').txt(entry.prefLabel);
        entryNode.ele('Description').txt(description);
        const refs = entryNode.ele('References');
        // Set backward HasComponent reference to the AFO Dictionary's NodeId.
        refs.ele('Reference', { ReferenceType: "HasComponent", IsForward: "false" }).txt(afoNodeId);
        refs.ele('Reference', { ReferenceType: "HasTypeDefinition" }).txt("i=17600");
    });

    return root.end({ prettyPrint: true });
}

/**
 * Converts a label to a valid TypeScript identifier.
 * If the label matches the pattern "<substr1> (<substr2>)",
 * it is transformed to "<substr1>_of_<substr2>".
 * Then, non-alphanumeric characters are replaced with underscores,
 * and if the identifier starts with a digit, an underscore is prefixed.
 *
 * @param label The input label (e.g. the prefLabel or termType).
 * @returns A valid TypeScript identifier.
 */
function toValidIdentifier(label: string): string {
    // Check if label matches the pattern "<substr1> (<substr2>)"
    const specialMatch = label.match(/^(.*?)\s*\(\s*(.*?)\s*\)$/);
    if (specialMatch) {
        // Replace with "substr1_of_substr2"
        label = `${specialMatch[1]}_of_${specialMatch[2]}`;
    }
    let identifier = label.replace(/\W+/g, '_');
    identifier = identifier.replace(/^_+|_+$/g, '');
    if (/^\d/.test(identifier)) {
        identifier = '_' + identifier;
    }
    return identifier;
}

/**
 * Generates TypeScript code that maps the prefLabel of each dictionary entry to its termIRI.
 * It creates a class named DictionaryEntryIds with static readonly members.
 *
 * @param entries An array of DictionaryEntry objects.
 * @returns A string containing the generated TypeScript code.
 */
function generateEntryIDictionarydsTSCode(entries: DictionaryEntry[], filename: string): string {
    const reservedKeywords = ['length']
    // First, compute the frequency of each valid prefLabel
    const frequency: Record<string, number> = {};
    for (const entry of entries) {
        const baseId = toValidIdentifier(entry.prefLabel);
        frequency[baseId] = (frequency[baseId] || 0) + 1;
    }

    let code = `// Source  ${filename}\nexport class AFODictionaryIds {\n`;
    for (const entry of entries) {
        const baseId = toValidIdentifier(entry.prefLabel);
        // If the same base identifier occurs more than once, append termType
        let identifier = baseId;
        if ((frequency[baseId] > 1) || (baseId in reservedKeywords)) {
            identifier = `${baseId}_${toValidIdentifier(entry.termType || '')}`;
        }
        code += `  public static readonly ${identifier} = "${entry.termIRI}"; // ${entry.definition.replace(/[\r\n]+/g, '')} \n`;
    }
    code += `}\n`;
    return code;
}

async function exportDictionaryEntryIds(dictionaryEntries: DictionaryEntry[], filePath: string, dictionaryName: string) {
    const code = generateEntryIDictionarydsTSCode(dictionaryEntries, dictionaryName);
    await fs.promises.writeFile(filePath, code, 'utf-8');
    console.log(`Typescript code exported to: ${filePath}`);
}

async function exportXML(dictionaryEntries: DictionaryEntry[], filePath: string) {
    const xmlContent = generateNodeset2XML(dictionaryEntries);
    await fs.promises.writeFile(filePath, xmlContent, 'utf-8');
    console.log(`XML exported to: ${filePath}`);
}

async function main(fileName = 'AFO_Dictionary-2025_03.csv') {
    const basePath = path.resolve(__dirname, '../../../../..')
    const csvPath = path.resolve(basePath, 'packages/afo/tools/data', fileName)
    const dictionaryEntries = await importCSV(csvPath)
    await exportDictionaryEntryIds(dictionaryEntries, path.resolve(basePath, 'packages/afo/src/', 'lads-afo-ids.ts'), path.parse(fileName).name)
    await exportXML(dictionaryEntries, path.resolve(basePath, 'nodesets', 'AFO_Dictionary.NodeSet2.xml'))
}

main()
