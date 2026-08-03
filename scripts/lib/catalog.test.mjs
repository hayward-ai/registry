// Zero-dependency tests for the catalog's pure logic: scoped-name parsing (which is
// also the path-safety boundary) and semver precedence (which decides what
// `latestVersion` means). Run with `npm test` / `node --test scripts/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseName, detailRelPath, compareVersions, isSemver } from './catalog.mjs';

test('parseName splits a scoped name', () => {
    assert.deepEqual(parseName('@hayward/fs'), { scope: 'hayward', shortName: 'fs', scopeDir: '@hayward' });
    assert.deepEqual(parseName('@acme-co/web-search').shortName, 'web-search');
});

test('parseName rejects anything that is not @scope/name', () => {
    for (const bad of [
        'fs', // unscoped
        '@hayward', // no name half
        '@hayward/', // empty name
        '@/fs', // empty scope
        '@Hayward/fs', // uppercase
        '@hayward/fs.json', // dots
        '@hayward/a/b', // nested
        '@-hayward/fs', // leading hyphen
        '@hayward/fs-', // trailing hyphen
        '@hayward/../evil', // traversal
        '@hayward/..', // traversal
        '', // empty
        null,
        undefined,
        42,
    ]) {
        assert.throws(() => parseName(bad), `expected ${JSON.stringify(bad)} to be rejected`);
    }
});

test('detailRelPath shards by scope and cannot escape collections/', () => {
    assert.equal(detailRelPath('@hayward/fs'), 'collections/@hayward/fs.json');
    // Every name that reaches a path has already been through parseName, so a
    // traversal attempt fails loudly rather than resolving somewhere.
    assert.throws(() => detailRelPath('../../etc/passwd'));
    assert.throws(() => detailRelPath('@hayward/../../.github/workflows/publish'));
});

test('isSemver accepts releases and prereleases, rejects the rest', () => {
    for (const good of ['0.1.0', '1.2.3', '10.20.30', '1.0.0-rc.1', '1.0.0-alpha.2+build.7']) {
        assert.equal(isSemver(good), true, good);
    }
    for (const bad of ['1', '1.2', 'v1.2.3', '1.2.3.4', 'latest', '']) {
        assert.equal(isSemver(bad), false, bad);
    }
});

test('compareVersions follows semver precedence, not string order', () => {
    const asc = (a, b) => assert.ok(compareVersions(a, b) < 0, `${a} should sort below ${b}`);
    asc('0.1.0', '0.2.0');
    asc('0.9.0', '0.10.0'); // the case string compare gets wrong
    asc('1.0.0-rc.1', '1.0.0'); // a prerelease ranks below its release
    asc('1.0.0-alpha', '1.0.0-alpha.1'); // fewer identifiers rank lower
    asc('1.0.0-alpha.1', '1.0.0-alpha.beta'); // numeric ranks below alphanumeric
    asc('1.0.0-beta', '1.0.0-beta.2');
    asc('1.0.0', '2.0.0');
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
    // Build metadata is ignored for precedence.
    assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
});

test('sorting a version list puts the genuine maximum last', () => {
    const sorted = ['0.2.0', '0.1.1', '1.0.0-rc.1', '0.10.0'].sort(compareVersions);
    assert.deepEqual(sorted, ['0.1.1', '0.2.0', '0.10.0', '1.0.0-rc.1']);
});
