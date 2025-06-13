// OPC UA ➜ QUDT Unit Converter (TypeScript)
// ------------------------------------------------------
// • Computes UnitId ⇆ UNECE code (no static table)
// • Loads QUDT Turtle once (lazy singleton) → in‑memory map
// • Exports a static TypeScript class containing all loaded QUDT units
//   so that production builds can drop the Turtle dependency.
// --------------------------------------------------------------------------

import fs from "fs";
import path, { join } from "path";
import { Literal, Parser } from "n3";
import { coerceNodeId } from "node-opcua";

// ----------- EUInformation & helpers --------------------------------------
export interface EUInformation {
    namespaceUri: string;
    unitId: number;
    displayName: Record<string, string>;
    description: Record<string, string>;
}
export function unitIdFromUNECE(code: string): number {
    if (!/^[A-Z]{3}$/.test(code)) throw new Error("UNECE code must be 3 uppercase letters");
    return 65536 * code.charCodeAt(0) + 256 * code.charCodeAt(1) + code.charCodeAt(2);
}
export function uneceFromUnitId(id: number): string {
    return String.fromCharCode((id >> 16) & 0xff) +
        String.fromCharCode((id >> 8) & 0xff) +
        String.fromCharCode(id & 0xff);
}

// ----------- QUDT domain model -------------------------------------------
export interface QudtUnit {
    uri: string;
    unece: string;
    symbol: string;
    label: string;
}
export interface UnitMapping {
    qudtSymbol: string;
    qudtURI: string;
    displayName: string;
    qudtLabel: string;
}

// ----------- QUDT Repository (singleton) ----------------------------------
export class QudtRepository {
    private unitsByUnece = new Map<string, QudtUnit>();
    private static _instance: QudtRepository | null = null;

    private constructor(units: QudtUnit[]) {
        units.forEach(u => this.unitsByUnece.set(u.unece, u));
    }

    /** Load QUDT Turtle once; cache instance. */
    static async load(turtlePath: string): Promise<QudtRepository> {
        if (this._instance) return this._instance;

        const ttl = fs.readFileSync(turtlePath, "utf-8");
        const triples = new Parser({ baseIRI: "http://qudt.org/vocab/unit/" }).parse(ttl);
        const temp: Record<string, Partial<QudtUnit>> = {};

        triples.forEach(t => {
            const s = t.subject.value;
            const p = t.predicate.value;
            const v = (t.object as any).value;
            if (!temp[s]) temp[s] = { uri: s };
            if (p.endsWith("uneceCommonCode")) temp[s].unece = v;
            else if (p.endsWith("symbol")) temp[s].symbol = v;
            else if (p.endsWith("label")) {
                const literal = t.object as Literal
                if (literal.language === "en") temp[s].label = v;
            }
        });

        const units: QudtUnit[] = Object.values(temp).filter(u => u.unece && u.symbol && u.label) as QudtUnit[];
        this._instance = new QudtRepository(units);
        return this._instance;
    }

    getByUnece(code: string): QudtUnit | undefined {
        return this.unitsByUnece.get(code);
    }

    /** Export all units to a static readonly TypeScript class */
    exportStaticTS(outPath: string, className = "QudtUnitStatic") {
        const entries = Array.from(this.unitsByUnece.values())
            .map(u => `  { uri: '${u.uri}', unece: '${u.unece}', symbol: '${u.symbol.replace(/'/g, "\\'")}', label: '${u.label.replace(/'/g, "\\'")}' }`)
            .join(",\n");

        const code = `// Auto‑generated file – do not edit manually\nexport interface QudtUnit { uri: string; unece: string; symbol: string; label: string; comment?: string; }\nexport class ${className} {\n  static readonly UNITS: ReadonlyArray<QudtUnit> = [\n${entries}\n  ];\n  static byUnece(code: string): QudtUnit | undefined {\n    return ${className}.UNITS.find(u => u.unece === code);\n  }\n}`;

        fs.writeFileSync(path.resolve(outPath), code, "utf-8");
        console.log(`Static TS class written to ${outPath}`);
    }
}

// ----------- Conversion helper -------------------------------------------
export async function mapEUToQudt(eu: EUInformation, repo: QudtRepository): Promise<UnitMapping | null> {
    const unece = uneceFromUnitId(eu.unitId);
    const unit = repo.getByUnece(unece);
    if (!unit) return null;
    return {
        qudtSymbol: unit.symbol,
        qudtURI: unit.uri,
        displayName: eu.displayName["en"] ?? unece,
        qudtLabel: unit.label
    };
}

// ----------- Example CLI demo --------------------------------------------
(async () => {
    const dir = join(process.cwd(), "lib/qudt")
    const repo = await QudtRepository.load(join(dir, "unit.ttl"));

    // Optional: export static TS class for production builds
    repo.exportStaticTS(join(dir, "qudt-units.ts"))

    const demoEU: EUInformation = {
        namespaceUri: "http://opcfoundation.org/UA/units/un/cefact",
        unitId: unitIdFromUNECE("CEL"),
        displayName: { en: "degC" },
        description: { en: "degree Celsius" }
    };

    console.log(await mapEUToQudt(demoEU, repo));
})();
