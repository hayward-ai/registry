# Hayward tool registry

A searchable catalogue of **tool collections** for [Hayward](https://github.com/hayward-ai)
agents. Each collection is a WebAssembly component, published once as an **OCI
artifact** (e.g. to `ghcr.io`) and described here so the Hayward app can browse it
and install it into a namespace (todo #38/#39).

The registry holds **no wasm bytes** — only metadata. The bytes live in the OCI
registry; Hayward's worker pulls them by digest at run time.

> **Bootstrap state (2026-08-02).** This catalogue is hand-built and holds exactly
> one collection: `@hayward/workspace@0.2.0`, published to
> `ghcr.io/hayward-ai/hayward-tools/workspace` and pullable anonymously.
>
> The earlier entries — `fs`, `bash`, `github`, `web-fetch`, `web-search` — were
> recorded against a local `registry:2` on `localhost:5000` and so resolved nowhere
> off the machine that built them; they have been removed rather than left looking
> installable. `fs` and `bash` are gone for good, replaced by `workspace`. The rest
> return as their repos are tagged: each tool repo's `build.yml` pushes to GHCR on a
> `v*` tag and prints the `record.mjs` command to run here.
>
> Until more are recorded, `pnpm web:init` needs `--allow-missing`.

## Names are scoped

Every collection is named `@scope/name` — `@hayward/fs`, `@acme/jira`. There are no
unscoped names, deliberately: a scope is owned by a user or org, so publishing is
authorised **per scope** rather than per name, and a first publish can't squat a
bare word like `github`. `@hayward` is an ordinary scope with no special standing —
the first-party collections live under it because the project claims it like anyone
else claims theirs, not because the registry treats it differently.

The full scoped name is the wire key — what an install stores, what the API is
queried by. The UI may show the short half with the scope as a publisher label.

## Layout

```
index.json                       # thin, searchable catalogue (generated)
collections/@<scope>/<name>.json # one detail file per collection (source of truth)
scripts/                         # record a release + regenerate the index
.nojekyll                        # so GitHub Pages serves this repo verbatim
```

The whole catalogue is static JSON, which is the point: it is served by GitHub
Pages at `https://hayward-ai.github.io/registry`, and the app reads it
*server-side* (see `TOOL_REGISTRY_URL` below), so there is no API to run and no
CORS to configure. `.nojekyll` matters because Pages otherwise runs Jekyll over
the branch, which skips paths it considers special — cheap insurance for a tree
whose directories all begin with `@`.

- **`index.json`** carries only what a browse/search view needs — name, scope,
  kind, displayName, description, author, category, latestVersion, toolCount —
  plus a `detail` path. It is **generated** from the detail files; never edit it
  by hand (`npm run generate`).

  Note what is *not* there: `icon`. A manifest icon is normally an inlined
  `data:image/svg+xml,…` URI, which is what lets a third-party publisher ship one
  without hosting anything and keeps the viewer's browser from contacting any host
  outside the app. Inlined in the index it dominated the row — 555 of 936 bytes for
  one small SVG, against a 64KB schema cap — in a file every browsing client
  downloads whole. The blob stays in the detail document; consumers render it from
  their own origin.
- **`collections/@<scope>/<name>.json`** is the full document for one collection:
  the authored `tool.json` verbatim, plus OCI coordinates and a version history.
  The **scope is the shard** — `collections/@hayward/workspace.json` — so a name can
  never resolve outside `collections/` (both halves are validated as strict slugs).
  Note the shard is by *publisher*, which bounds a directory per scope but not the
  scope itself: `@hayward` grows with the first-party set, and `collections/` grows
  with the number of publishers. Neither is near mattering.

### Detail file shape

```jsonc
{
  "schemaVersion": 1,          // version of this envelope, not of the manifest
  "kind": "tool-collection",   // lifted from the manifest so consumers can filter without descending
  "name": "@hayward/web-search",
  "scope": "@hayward",
  "shortName": "web-search",
  "manifest": { /* the tool's tool.json, byte-for-byte as authored */ },
  "oci": { "registry": "ghcr.io", "path": "hayward/hayward-tools/web-search" },
  "latestVersion": "0.1.0",
  "versions": [
    {
      "version": "0.1.0",
      "contentDigest": "sha256:…",   // sha256(wasm) — what the worker pulls by
      "manifestDigest": "sha256:…",  // sha256(tool.json) — verifiable against the tool repo
      "reference": "ghcr.io/hayward/hayward-tools/web-search:0.1.0",
      "publishedAt": "…"
    }
  ]
}
```

The manifest is embedded **verbatim** rather than having its fields copied up. That
keeps the published document comparable with the `tool.json` in the tool's own repo
— clone it at the version's tag, hash the file, and it must equal `manifestDigest` —
and it means a field added to the manifest schema reaches the registry without a
code change here. Consumers read `manifest.tools`, `manifest.configSchema`, and so
on; only the envelope fields above belong to the registry.

### Versions are immutable

Re-recording a published version with different bytes is rejected. Publish a new
version instead. `--allow-overwrite` exists for the local loop below, where
rebuilding the same version legitimately changes the digest — never for a real
publish. `latestVersion` is the highest version by **semver precedence**, ignoring
prereleases unless that's all there is, so a late patch to an old line doesn't
become "latest".

`oci.registry` + `oci.path` + the selected version's `contentDigest` are exactly
what an installed `ToolCollection` stores (`ociRegistry`/`ociPath`/`contentDigest`)
and what the worker fetches: `GET /v2/<oci.path>/blobs/<contentDigest>`. The wasm
component is published as a **single-layer** artifact whose layer digest **is**
that `contentDigest`, so no manifest walk or tag is needed to fetch it.

## Publishing: bytes are automated, metadata is not

Publishing splits into two halves, and they have very different risk profiles:

- **The bytes.** A tool repo's `build.yml` pushes its component to
  `ghcr.io/<owner>/hayward-tools/<name>:<version>` on a `v*` tag, using
  `secrets.GITHUB_TOKEN` with `packages: write`. That token can only write packages
  belonging to that repo, so there's no cross-repo credential anywhere.
- **The metadata.** Recording a version *here* is manual, and moves to the registry
  backend when it exists — that's where auth, scope ownership, and submission
  validation belong.

**A pushed artifact is inert until it's recorded.** Nothing can install a collection
from bytes alone, which is exactly why automating the push front-runs none of the
checks the backend will add. It's also the reason no `REGISTRY_PUSH_PAT` exists: the
shared `publish-tool` composite action that used to live in this repo's `.github/`
did both halves, and needed a token in every tool repo that could write the whole
catalogue. It's gone.

> **GHCR packages are private by default** when pushed from a private repo, and the
> worker pulls anonymously first (falling back to a bearer-token challenge). A package
> has to be made public — a one-time per-package setting in GHCR — or the worker can't
> fetch it. Nothing in the pipeline warns about this; it surfaces as a failed warm.

### Recording a release

After a `v*` tag, the tool's workflow run summary prints the exact `record.mjs`
command for what it just pushed, digest included — copy it, run it here, open a PR.

Doing it from scratch (a local build, or against a local registry) is the same two
steps:

```sh
podman run -d --rm -p 5000:5000 docker.io/library/registry:2

cd ../tools/web-search && npm run build     # or cargo build --release --target wasm32-wasip2
WASM=dist/component.wasm
oras push localhost:5000/hayward-tools/web-search:0.1.0 \
  --artifact-type application/vnd.wasm.component.v1+wasm \
  "$WASM:application/wasm"

cd ../../registry
node scripts/record.mjs --tool-json ../tools/web-search/tool.json \
  --registry localhost:5000 --path hayward-tools/web-search \
  --version 0.1.0 --digest "sha256:$(sha256sum "../tools/web-search/$WASM" | cut -d' ' -f1)" \
  --allow-overwrite
```

It writes the collection's detail file and regenerates `index.json`. The collection
name comes from the manifest's `name`, not a flag, so there's no way for the artifact
and the record to disagree about what was published.

Two things to keep straight when doing this by hand:

- **The digest must be `sha256` of the wasm file itself**, not of an OCI manifest. The
  artifact is single-layer precisely so those are the same bytes (see the digest trick
  above); pass the file's own hash and the worker's blob fetch will line up.
- **`--allow-overwrite` is what makes the loop repeatable.** Rebuilding `0.1.0`
  produces different bytes, which a real publish would correctly refuse. Don't get in
  the habit of passing it for versions anyone else has installed.

For a registry the app can reach from another machine, push to `ghcr.io` instead of
`localhost:5000` and pass the matching `--registry`/`--path`. Nothing else changes.

`npm test` covers the name-parsing and semver logic — worth running after touching
`scripts/lib/catalog.mjs`.

## Pointing Hayward at a registry

The app reads one of these (see hayward's `pnpm web:init`, which installs the
builtin collections from whichever is set):

```sh
TOOL_REGISTRY_URL=https://hayward-ai.github.io/registry  # http, the default posture
TOOL_REGISTRY_PATH=/abs/path/to/registry                # a local checkout (dev, air-gapped)
```

Note the two are independent of where the *bytes* come from: the app resolves
metadata through these, and the worker pulls the component from the `oci`
coordinates recorded in the detail file. A `TOOL_REGISTRY_PATH` checkout whose
collections point at `localhost:5000` needs that local OCI registry running for
the worker to warm anything.
