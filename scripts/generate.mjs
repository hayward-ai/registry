#!/usr/bin/env node
// Regenerates index.json from every collections/@scope/<name>.json detail file. The
// detail files are the source of truth; the index is a derived, thin, searchable
// catalog. Run after editing/publishing any collection.
//
// Also acts as the registry's integrity check, since it's the one step that sees
// every collection at once: it asserts each detail file sits at the path its own
// `name` derives to, and that no two files claim the same name. Both would
// otherwise surface as a collection that resolves to the wrong document.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { collectionsDir, indexPath, indexRow, detailRelPath, registryRoot } from './lib/catalog.mjs';

function allDetailFiles(dir) {
    if (!existsSync(dir)) return [];
    const out = [];
    for (const scope of readdirSync(dir, { withFileTypes: true })) {
        // Scope directories are the shard: collections/@hayward/fs.json.
        if (!scope.isDirectory() || !scope.name.startsWith('@')) continue;
        for (const f of readdirSync(join(dir, scope.name))) {
            if (f.endsWith('.json')) out.push(join(dir, scope.name, f));
        }
    }
    return out;
}

const seen = new Map();
const collections = [];
for (const file of allDetailFiles(collectionsDir)) {
    const rel = relative(registryRoot, file);
    let detail;
    try {
        detail = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (e) {
        throw new Error(`${rel}: not valid JSON — ${e.message}`);
    }
    // Throws on a malformed or unscoped name, so a bad detail file fails the
    // generate rather than producing an index row nothing can resolve.
    const expected = detailRelPath(detail.name);
    if (expected !== rel.split('\\').join('/')) {
        throw new Error(`${rel}: collection '${detail.name}' belongs at ${expected}`);
    }
    if (seen.has(detail.name)) throw new Error(`duplicate collection '${detail.name}' in ${seen.get(detail.name)} and ${rel}`);
    seen.set(detail.name, rel);
    collections.push(indexRow(detail));
}
collections.sort((a, b) => a.name.localeCompare(b.name));

const index = { schemaVersion: 1, generatedAt: new Date().toISOString(), collections };
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
console.log(`wrote ${indexPath} with ${collections.length} collection(s)`);
