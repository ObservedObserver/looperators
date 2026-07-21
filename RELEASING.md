# Releasing looperators for macOS arm64

The first update-enabled release is a migration baseline. Users of `0.1.0`
must install that baseline manually because `0.1.0` does not contain the
update-checking runtime. Once the baseline is installed, packaged Apple Silicon
builds check the public GitHub Releases feed automatically and show a download
notice when a newer stable release is available.

## One-time GitHub setup

Configure these Actions secrets:

- `CSC_LINK`: base64-encoded Developer ID Application `.p12`
- `CSC_KEY_PASSWORD`: password used to export the `.p12`
- `APPLE_API_KEY`: raw App Store Connect API `.p8` contents
- `APPLE_API_KEY_ID`: App Store Connect API key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID

The signing certificate must remain the same Developer ID identity used for
the existing app (`com.observedobserver.looperators`, Team ID `6RAXH4XM34`).
The release workflow fails instead of publishing an unsigned, unnotarized,
wrong-architecture, or incorrectly signed update when any signing credential
or expected updater asset is missing.

## Publish a release

Use a stable SemVer tag:

```sh
git tag v0.2.0
git push origin v0.2.0
```

The `Release macOS arm64` workflow then:

1. injects the tag version into `package.json` and the packaged app;
2. runs lint, build, and deterministic graph-core tests;
3. builds arm64 DMG and ZIP artifacts;
4. signs, notarizes, and staples the application;
5. verifies `latest-mac.yml` and differential-update blockmaps;
6. publishes all required files in one public GitHub Release.

The workflow can also be started manually with a version from the Actions UI.
Do not upload only the DMG and ZIP: update detection depends on
`latest-mac.yml`, and future in-app downloads will depend on the blockmaps.

## Local packaging check

On an Apple Silicon Mac with a signing identity available in Keychain:

```sh
npm run pack:mac
```

For a full DMG/ZIP build:

```sh
npm run dist:mac
```

Local development builds intentionally report update checks as disabled. Test
the real GitHub feed from an installed, signed production build.
