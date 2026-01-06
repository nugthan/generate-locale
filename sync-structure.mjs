#!/usr/bin/env node
/**
 * sync-locale-structure.mjs
 *
 * Compare & normalize locale YAML structure.
 *
 * - Reorders target keys to match reference (for readability/diffs)
 * - Adds missing keys from reference into target (placeholder choice)
 * - Keeps target-only keys, appended after reference-ordered keys
 *
 * Usage:
 *   node sync-locale-structure.mjs --ref en-us.yaml --target fr-fr.yaml --out fr-fr.yaml
 *
 * Optional:
 *   --missing "empty"    (default) missing strings -> ""
 *   --missing "null"               missing leaves -> null
 *   --missing "ref"                missing leaves -> copy value from reference (useful for IDs or non-translated stuff)
 *   --report                       print missing/extra key lists
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const args = process.argv.slice(2);
function getArg(name, fallback = null) {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1) return fallback;
    return args[idx + 1] ?? fallback;
}
function hasFlag(name) {
    return args.includes(`--${name}`);
}

const refPath = getArg("ref");
const targetPath = getArg("target");
const outPath = getArg("out", null);
const missingMode = (getArg("missing", "empty") || "empty").toLowerCase();
const report = hasFlag("report");

if (!refPath || !targetPath) {
    console.error(
        'Usage: node sync-locale-structure.mjs --ref en-us.yaml --target fr-fr.yaml --out fr-fr.yaml'
    );
    process.exit(1);
}

function readYaml(p) {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = YAML.parse(raw);
    return parsed ?? {};
}

function isObject(v) {
    return v != null && typeof v === "object" && !Array.isArray(v);
}

// Build a "leaf placeholder" when target is missing something reference has.
function missingLeaf(refLeaf) {
    if (missingMode === "null") return null;
    if (missingMode === "ref") return refLeaf;
    // default "empty"
    if (typeof refLeaf === "string") return "";
    // if ref leaf is number/bool/null, keep type neutral:
    return refLeaf == null ? "" : "";
}

// Merge + reorder recursively
function reorderLike(refNode, tgtNode, keyPath, stats) {
    // If reference is an array:
    if (Array.isArray(refNode)) {
        const refArr = refNode;
        const tgtArr = Array.isArray(tgtNode) ? tgtNode : [];

        const out = [];
        const maxLen = Math.max(refArr.length, tgtArr.length);

        for (let i = 0; i < maxLen; i++) {
            const refVal = refArr[i];
            const tgtVal = tgtArr[i];

            const p = `${keyPath}[${i}]`;

            if (refVal === undefined && tgtVal !== undefined) {
                // target has extra elements beyond ref
                out.push(tgtVal);
                stats.extra.push(p);
                continue;
            }

            if (tgtVal === undefined) {
                // missing element
                if (isObject(refVal) || Array.isArray(refVal)) {
                    out.push(reorderLike(refVal, undefined, p, stats));
                } else {
                    out.push(missingLeaf(refVal));
                }
                stats.missing.push(p);
                continue;
            }

            // both exist
            if (isObject(refVal) || Array.isArray(refVal)) {
                out.push(reorderLike(refVal, tgtVal, p, stats));
            } else {
                out.push(tgtVal);
            }
        }
        return out;
    }

    // If reference is an object:
    if (isObject(refNode)) {
        const refObj = refNode;
        const tgtObj = isObject(tgtNode) ? tgtNode : {};

        const out = {};

        // 1) keys in reference order
        for (const k of Object.keys(refObj)) {
            const p = keyPath ? `${keyPath}.${k}` : k;

            if (!(k in tgtObj)) {
                // missing in target
                const refVal = refObj[k];
                if (isObject(refVal) || Array.isArray(refVal)) {
                    out[k] = reorderLike(refVal, undefined, p, stats);
                } else {
                    out[k] = missingLeaf(refVal);
                }
                stats.missing.push(p);
                continue;
            }

            const refVal = refObj[k];
            const tgtVal = tgtObj[k];

            if (isObject(refVal) || Array.isArray(refVal)) {
                out[k] = reorderLike(refVal, tgtVal, p, stats);
            } else {
                out[k] = tgtVal;
            }
        }

        // 2) target-only keys appended (preserve their order as-is)
        for (const k of Object.keys(tgtObj)) {
            if (k in refObj) continue;
            const p = keyPath ? `${keyPath}.${k}` : k;
            out[k] = tgtObj[k];
            stats.extra.push(p);
        }

        return out;
    }

    // Reference is a leaf:
    if (tgtNode === undefined) {
        stats.missing.push(keyPath || "(root)");
        return missingLeaf(refNode);
    }
    return tgtNode;
}

const ref = readYaml(refPath);
const tgt = readYaml(targetPath);

const stats = { missing: [], extra: [] };
const normalized = reorderLike(ref, tgt, "", stats);

const doc = new YAML.Document(normalized);
if (doc.contents) doc.contents.commentBefore = "Reordered to match reference structure.";

const finalOutPath = outPath || targetPath;
fs.mkdirSync(path.dirname(finalOutPath), { recursive: true });
fs.writeFileSync(finalOutPath, String(doc), "utf8");

console.log(`Wrote ${finalOutPath}`);

if (report) {
    console.log(`\nMissing keys added (${stats.missing.length}):`);
    for (const k of stats.missing) console.log(` - ${k}`);
    console.log(`\nExtra keys kept (${stats.extra.length}):`);
    for (const k of stats.extra) console.log(` - ${k}`);
}
