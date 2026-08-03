// Shared layout helpers for the on-disk registry: how a collection's scoped name
// maps to a path, what the registry writes into a detail file, and what the thin
// search index row looks like. The detail files under collections/** are the single
// source of truth; index.json is derived (see generate.mjs).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const registryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const collectionsDir = join(registryRoot, 'collections');
export const indexPath = join(registryRoot, 'index.json');

// The only `kind` this registry stores today. A manifest must declare it
// explicitly so a future kind (agent template, skill bundle, MCP server
// descriptor) can share the catalog: index rows carry `kind`, and a consumer that
// doesn't recognise one is expected to skip the row rather than fail.
export const MANIFEST_KIND = 'tool-collection';

// Version of the *detail envelope* this module writes (the fields around
// `manifest`). Independent of the manifest's own `schemaVersion`, which the tool
// author sets.
export const SCHEMA_VERSION = 1;

// Collection names are scoped — `@scope/name` — so ownership is per-scope rather
// than per-name (you own `@acme`, you publish anything under it) and a first
// publish can't squat a bare word. Both halves are validated separately and hold
// no dots or slashes, which is also what makes path derivation safe: a name can
// never traverse out of collections/.
const SCOPE_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const SHORT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Splits `@scope/name` into its parts, throwing on anything that isn't a
 * well-formed scoped name. `scopeDir` is the on-disk directory for the scope
 * (`@acme`), which is also how collections are sharded — the scope *is* the shard,
 * so directories stay small and browsable without a synthetic prefix.
 */
export function parseName(name) {
    if (typeof name !== 'string' || !name.startsWith('@')) {
        throw new Error(`collection name must be scoped as '@scope/name' (got ${JSON.stringify(name)})`);
    }
    const slash = name.indexOf('/');
    if (slash < 0) throw new Error(`collection name '${name}' is missing the '/name' half of '@scope/name'`);
    const scope = name.slice(1, slash);
    const shortName = name.slice(slash + 1);
    if (!SCOPE_RE.test(scope)) {
        throw new Error(`invalid scope '@${scope}' in '${name}': lowercase letters, digits and inner hyphens only, max 39 chars`);
    }
    if (!SHORT_NAME_RE.test(shortName)) {
        throw new Error(`invalid name '${shortName}' in '${name}': lowercase letters, digits and inner hyphens only, max 64 chars`);
    }
    return { scope, shortName, scopeDir: `@${scope}` };
}

export function detailRelPath(name) {
    const { scopeDir, shortName } = parseName(name);
    return `collections/${scopeDir}/${shortName}.json`;
}

export function detailAbsPath(name) {
    return join(registryRoot, detailRelPath(name));
}

// --- semver ------------------------------------------------------------------
// Versions are compared by semver precedence, not string order: `localeCompare`
// with numeric collation orders 1.0.0-rc.1 above 1.0.0, and `latestVersion` has to
// be the genuine maximum (a 0.1.1 patch published after 0.2.0 must not become
// "latest").

function parseVersion(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-zA-Z.-]+))?(?:\+[0-9a-zA-Z.-]+)?$/.exec(v ?? '');
    return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null } : null;
}

export function isSemver(v) {
    return parseVersion(v) !== null;
}

function comparePre(a, b) {
    if (a === null && b === null) return 0;
    if (a === null) return 1; // a release outranks any prerelease of the same triple
    if (b === null) return -1;
    const as = a.split('.');
    const bs = b.split('.');
    for (let i = 0; i < Math.max(as.length, bs.length); i++) {
        const x = as[i];
        const y = bs[i];
        if (x === undefined) return -1; // a shorter set of identifiers has lower precedence
        if (y === undefined) return 1;
        const xNum = /^\d+$/.test(x);
        const yNum = /^\d+$/.test(y);
        if (xNum && yNum) {
            if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
        } else if (xNum !== yNum) {
            return xNum ? -1 : 1; // numeric identifiers rank below alphanumeric ones
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

export function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    // An unparseable version can only come from a hand-edited detail file; sort it
    // to the bottom rather than throwing, so the generator can still run.
    if (!pa || !pb) return !pa && !pb ? String(a).localeCompare(String(b)) : pa ? 1 : -1;
    return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch || comparePre(pa.pre, pb.pre);
}

// The highest released (non-prerelease) version, falling back to the highest
// prerelease when a collection has only ever published prereleases.
function latestOf(versions) {
    const sorted = [...versions].sort((a, b) => compareVersions(a.version, b.version));
    const released = sorted.filter((v) => parseVersion(v.version)?.pre === null);
    return (released.at(-1) ?? sorted.at(-1))?.version ?? null;
}

// --- recording ---------------------------------------------------------------

/**
 * Merges a newly-published version's OCI coordinates into a collection's detail
 * file (creating or updating it) and returns what was written.
 *
 * The authored manifest is embedded **verbatim** under `manifest` rather than
 * copied field by field. That keeps the published document comparable with the
 * `tool.json` in the tool's own repo (see `manifestDigest`), and means a field
 * added to the manifest schema reaches the registry without an edit here — the old
 * hand-copy silently dropped anything it didn't know about.
 *
 * Versions are immutable: re-recording an existing version with different bytes is
 * rejected unless `allowOverwrite` is set, which the local build loop needs since
 * rebuilding the same version legitimately changes the digest.
 */
export function recordVersion({ manifest, manifestBytes, registry, ociPath, version, contentDigest, reference, allowOverwrite = false }) {
    if (manifest?.kind !== MANIFEST_KIND) {
        throw new Error(`manifest must declare "kind": "${MANIFEST_KIND}" (got ${JSON.stringify(manifest?.kind)})`);
    }
    const { scope, shortName } = parseName(manifest?.name);
    if (!isSemver(version)) throw new Error(`version '${version}' is not valid semver (expected e.g. 1.2.3 or 1.2.3-rc.1)`);
    if (!DIGEST_RE.test(contentDigest ?? '')) throw new Error(`contentDigest '${contentDigest}' is not a lowercase sha256:<64 hex> digest`);
    if (!registry || !ociPath) throw new Error('registry and ociPath are required');

    const detailPath = detailAbsPath(manifest.name);
    const prev = existsSync(detailPath) ? JSON.parse(readFileSync(detailPath, 'utf-8')) : {};

    const priorEntry = (prev.versions ?? []).find((v) => v.version === version);
    if (priorEntry && priorEntry.contentDigest !== contentDigest && !allowOverwrite) {
        throw new Error(
            `${manifest.name}@${version} is already published with digest ${priorEntry.contentDigest}; ` +
                'publishing different bytes under the same version is not allowed. Publish a new version, ' +
                'or pass --allow-overwrite against a local/dev registry.',
        );
    }

    const entry = {
        // Spread the prior entry first so anything recorded alongside a version (a
        // yank marker, a signature, provenance) survives a re-record.
        ...priorEntry,
        version,
        contentDigest,
        // sha256 of the manifest *file bytes*, so anyone can clone the tool repo at
        // this version's tag and confirm the registry serves what was authored.
        manifestDigest: manifestBytes
            ? `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`
            : (priorEntry?.manifestDigest ?? null),
        reference: reference ?? `${registry}/${ociPath}:${version}`,
        publishedAt: new Date().toISOString(),
    };
    const versions = [...(prev.versions ?? []).filter((v) => v.version !== version), entry].sort((a, b) =>
        compareVersions(a.version, b.version),
    );

    const detail = {
        schemaVersion: SCHEMA_VERSION,
        kind: manifest.kind, // lifted out of the manifest so consumers can filter without descending into it
        name: manifest.name,
        scope: `@${scope}`,
        shortName,
        manifest,
        oci: { registry, path: ociPath },
        latestVersion: latestOf(versions),
        versions,
    };
    mkdirSync(dirname(detailPath), { recursive: true });
    writeFileSync(detailPath, JSON.stringify(detail, null, 2) + '\n');
    return { detail, detailPath };
}

// --- index ------------------------------------------------------------------

/**
 * The fields the index carries — enough to render and filter a browse list without
 * fetching every detail file. `detail` points at the full document; consumers
 * resolve it through that pointer rather than rebuilding a path from `name`.
 *
 * (`icon` is still inlined here. It's the one field that makes the index grow
 * faster than it needs to — moving icons out is read-path work, not schema work.)
 */
export function indexRow(detail) {
    const m = detail.manifest ?? {};
    return {
        name: detail.name,
        scope: detail.scope ?? null,
        kind: detail.kind ?? m.kind ?? null,
        displayName: m.displayName ?? null,
        description: m.description ?? null,
        author: m.author ?? null,
        category: m.category ?? null,
        // Deliberately not `icon`. A manifest icon is normally an inlined
        // `data:image/svg+xml,…` URI — self-contained, which is what lets a
        // third-party publisher ship one without hosting anything, and what keeps
        // the viewer's browser from ever contacting a host outside the app. But
        // inlined it dominated the row: 555 of 936 bytes for one small SVG, with
        // the manifest schema capping `icon` at 65536. Every client that browses
        // downloads this whole file, so the blobs live in the detail documents and
        // the app serves them from its own origin instead (see the registry icon
        // route). The index keeps only what a search/browse view filters on.
        latestVersion: detail.latestVersion ?? null,
        toolCount: Array.isArray(m.tools) ? m.tools.length : 0,
        detail: detailRelPath(detail.name),
    };
}
