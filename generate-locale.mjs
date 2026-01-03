#!/usr/bin/env node
/**
 * Turn your spreadsheet into a yaml file!
 *
 * Usage:
 *   node generate-locales.mjs --xlsx "translations.xlsx" --out "./locales"
 *
 * Optional:
 *   --sheet "Sheet1" (default: first sheet)
 *   --key-col "Key" // default key column name
 *   --loc-prefix "loc:" // default locale column prefix
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

if (!xlsxPath) {
    console.error('Usage: node generate-locales.mjs --xlsx "file.xlsx" --out "./locales"');
    process.exit(1);
}

// read the spreadsheet

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

// Get all the columns prefixed with loc:
const localeCols = headers.filter(h => locPrefixRe.test(h));
if (localeCols.length === 0) {
    throw new Error(
        `No locale columns found. Add headers like "${locPrefix}EN-US", "${locPrefix}FR-FR".`
    );
}

function localeHeaderToCode(h) {
    return String(h).replace(locPrefixRe, "").trim();
}

const outputs = {};
for (const col of localeCols) outputs[col] = {};

// Create the translations

const warnings = [];

for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const keys = splitMultiKey(r[keyColName]);
    if (keys.length === 0) continue;

    for (const key of keys) {
        for (const col of localeCols) {
            const raw = r[col];
            if (isBlank(raw)) continue;

            try {
                setDeep(outputs[col], key, String(raw));
            } catch (e) {
                warnings.push(`Row ${i + 2} col "${col}" key "${key}": ${e.message}`);
            }
        }
    }
}

// Write the files

for (const col of localeCols) {
    const code = localeHeaderToCode(col);
    const filename = code.toLowerCase().replace(/\s+/g, "-");
    const outPath = path.join(outDir, `${filename}.yaml`);

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

if (warnings.length) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log(" -", w);
}