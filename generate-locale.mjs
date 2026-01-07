#!/usr/bin/env node
/**
 * Turn your spreadsheet into a locale file!
 *
 * Usage:
 *   node generate-locales.mjs --xlsx "translations.xlsx" --out "./locales"
 *
 * Optional:
 *   --sheet "Sheet1"        (default: first sheet)
 *   --key-col "Key"         (default key column name)
 *   --loc-prefix "loc:"     (default locale column prefix)
 *   --ref "./en-us.yaml"    (reference yaml for structure)
 *   --missing blank|ref     (how to fill missing keys from ref)
 *   --ext "yaml"            (file extension, default: yaml)
 */

import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import YAML from "yaml";

// Helpers
function isBlank(v) {
    return v == null || String(v).trim() === "";
}
function splitMultiKey(cell) {
    return String(cell || "")
        .split(/[\n|,]+/g)
        .map(s => s.trim())
        .filter(Boolean);
}
function parseKey(key) {
    const out = [];
    const re = /([^.[]+)|\[(\d+)\]/g;
    let m;
    while ((m = re.exec(key))) {
        if (m[1]) out.push(m[1]);
        else out.push(Number(m[2]));
    }
    return out;
}
function ensureContainer(parent, prop, nextToken) {
    const wantsArray = typeof nextToken === "number";
    if (parent[prop] == null) parent[prop] = wantsArray ? [] : {};
    if (wantsArray && !Array.isArray(parent[prop])) parent[prop] = [];
    if (!wantsArray && Array.isArray(parent[prop])) parent[prop] = {};
    return parent[prop];
}
function setDeep(obj, key, value) {
    const tokens = parseKey(key);
    let cur = obj;

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const isLast = i === tokens.length - 1;
        const next = tokens[i + 1];

        if (isLast) {
            cur[t] = value;
            return;
        }

        if (typeof t === "number") {
            if (!Array.isArray(cur)) {
                throw new Error(`Expected array while setting "${key}"`);
            }
            if (cur[t] == null) cur[t] = typeof next === "number" ? [] : {};
            cur = cur[t];
            continue;
        }

        cur = ensureContainer(cur, t, next);
    }
}

// Reference merge helpers
function isObject(v) {
    return v != null && typeof v === "object" && !Array.isArray(v);
}

function createFromRef(refVal, mode) {
    if (Array.isArray(refVal)) {
        return refVal.map(v => createFromRef(v, mode));
    }
    if (isObject(refVal)) {
        const out = {};
        for (const k of Object.keys(refVal)) {
            out[k] = createFromRef(refVal[k], mode);
        }
        return out;
    }
    return mode === "ref" ? refVal : "";
}

function fillMissingFromRef(target, ref, mode) {
    if (Array.isArray(ref)) {
        if (!Array.isArray(target)) target = [];
        for (let i = 0; i < ref.length; i++) {
            if (target[i] === undefined) {
                target[i] = createFromRef(ref[i], mode);
            } else {
                fillMissingFromRef(target[i], ref[i], mode);
            }
        }
        return target;
    }

    if (isObject(ref)) {
        if (!isObject(target)) target = {};
        for (const k of Object.keys(ref)) {
            if (!(k in target)) {
                target[k] = createFromRef(ref[k], mode);
            } else {
                fillMissingFromRef(target[k], ref[k], mode);
            }
        }
        return target;
    }

    return target;
}

// CLI args
const args = process.argv.slice(2);
function getArg(name, fallback = null) {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1) return fallback;
    return args[idx + 1] ?? fallback;
}

const xlsxPath = getArg("xlsx");
const outDir = getArg("out", "./locales");
const sheetName = getArg("sheet", null);
const keyColName = getArg("key-col", "Key");
const locPrefix = getArg("loc-prefix", "loc:");
const refPath = getArg("ref", null);
const missingMode = (getArg("missing", "blank") || "blank").toLowerCase();
const fileExt = (getArg("ext", "yaml") || "yaml").replace(/^\./, "");

if (!xlsxPath) {
    console.error('Usage: node generate-locales.mjs --xlsx "file.xlsx" --out "./locales"');
    process.exit(1);
}

if (!["blank", "ref"].includes(missingMode)) {
    console.error('Invalid --missing value. Use "blank" or "ref"');
    process.exit(1);
}

// Read spreadsheet
fs.mkdirSync(outDir, { recursive: true });

const wb = XLSX.readFile(xlsxPath, { cellDates: false });
const wsName = sheetName || wb.SheetNames[0];
const ws = wb.Sheets[wsName];
if (!ws) throw new Error(`Sheet not found: ${wsName}`);

const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
if (rows.length === 0) throw new Error("No rows found in sheet.");

const headers = Object.keys(rows[0] ?? {});
const locPrefixRe = new RegExp(
    `^${locPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "i"
);

// Locale columns
const localeCols = headers.filter(h => locPrefixRe.test(h));
if (localeCols.length === 0) {
    throw new Error(`No locale columns found. Use headers like "${locPrefix}EN-US"`);
}

function localeHeaderToCode(h) {
    return String(h).replace(locPrefixRe, "").trim();
}

// Load reference yaml
let refObj = null;
if (refPath) {
    const raw = fs.readFileSync(refPath, "utf8");
    refObj = YAML.parse(raw) ?? {};
}

// Build outputs
const outputs = {};
for (const col of localeCols) outputs[col] = {};

// Apply spreadsheet values
for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const keys = splitMultiKey(r[keyColName]);
    if (keys.length === 0) continue;

    for (const key of keys) {
        for (const col of localeCols) {
            const raw = r[col];
            if (isBlank(raw)) continue;
            setDeep(outputs[col], key, String(raw));
        }
    }
}

// Merge reference structure
if (refObj) {
    for (const col of localeCols) {
        outputs[col] = fillMissingFromRef(outputs[col], refObj, missingMode);
    }
}

// Write files
for (const col of localeCols) {
    const code = localeHeaderToCode(col);
    const filename = code.toLowerCase().replace(/\s+/g, "-");
    const outPath = path.join(outDir, `${filename}.${fileExt}`);

    const doc = new YAML.Document(outputs[col]);
    if (doc.contents) doc.contents.commentBefore = "Generated from spreadsheet.";

    fs.writeFileSync(outPath, String(doc), "utf8");
    console.log(`Wrote ${outPath}`);
}

// Summary
console.log("\nLocales generated:");
for (const col of localeCols) {
    console.log(` - ${localeHeaderToCode(col)}`);
}
