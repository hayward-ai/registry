#!/usr/bin/env node
// Records an already-published OCI artifact in this registry — the CI half of
// publishing, with no build or push. A tool repo's publish workflow builds +
// `oras push`es the wasm, then (via a registry checkout) runs this to write the
// collection's detail file and refresh index.json:
//
//   node scripts/record.mjs --tool-json ../tool/tool.json \
//     --registry ghcr.io --path owner/hayward-tools/web-search \
//     --version 0.1.0 --digest sha256:… [--reference ghcr.io/…:0.1.0]
//
// The collection name comes from the manifest's scoped `name` (`@hayward/fs`), not
// from a flag — the manifest is the one place it's declared.
//
// A published version is immutable. Re-recording one with a different digest fails
// unless --allow-overwrite is passed, which is for the local loop (rebuild → push
// → record against a `registry:2` on localhost), never for a real publish.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordVersion, indexPath } from './lib/catalog.mjs';

const FLAGS = new Set(['allow-overwrite']);

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        // Valueless flags must not swallow the following argument.
        args[key] = FLAGS.has(key) ? true : argv[++i];
    }
    return args;
}

// A rejected publish is a message for whoever wrote the manifest, usually read in a
// CI log — a node stack trace buries it.
function die(message) {
    console.error(`record: ${message}`);
    process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
for (const req of ['tool-json', 'registry', 'path', 'version', 'digest']) {
    if (!args[req]) die(`missing --${req}`);
}

// Kept as bytes as well as parsed: the recorded `manifestDigest` is the hash of the
// file exactly as authored, so it can be verified against the tool repo at its tag.
let manifestBytes;
let manifest;
try {
    manifestBytes = readFileSync(args['tool-json']);
    manifest = JSON.parse(manifestBytes.toString('utf-8'));
} catch (e) {
    die(`could not read ${args['tool-json']}: ${e.message}`);
}

let detailPath;
try {
    ({ detailPath } = recordVersion({
        manifest,
        manifestBytes,
        registry: args.registry,
        ociPath: args.path,
        version: args.version,
        contentDigest: args.digest,
        reference: args.reference,
        allowOverwrite: args['allow-overwrite'] === true,
    }));
} catch (e) {
    die(e.message);
}
console.log(`recorded ${manifest.name}@${args.version} -> ${detailPath}`);

execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'generate.mjs')], { stdio: 'inherit' });
console.log(`refreshed ${indexPath}`);
