# Signing macOS releases

AgentTeam supports Developer ID signing, hardened runtime and Apple notarization through electron-builder. An Apple Developer Program membership and a **Developer ID Application** certificate with its private key are required. An Apple Development certificate is not sufficient for public distribution outside the App Store.

## Local build

With the certificate already installed in your keychain, set `CSC_NAME` to its Developer ID identity name, then run `npm run package`. Alternatively set `CSC_LINK` to a `.p12` certificate path and `CSC_KEY_PASSWORD` to its export password.

For notarization, also provide `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` as environment variables. Do not put them in source files or commit them. When signing is enabled, the packaging script sets `forceCodeSigning` so a missing/invalid certificate fails the build instead of silently producing an unsigned binary. Notarization runs only when all three notarization variables are supplied.

The macOS build uses hardened runtime and the JIT entitlement required by Electron. The app and its helpers are signed by electron-builder. With notarization enabled, the packaging process submits to Apple and staples the ticket according to electron-builder's notarization integration.

## GitHub Actions

Set repository Actions secrets:

| Secret | Value |
| --- | --- |
| `MAC_CERTIFICATE_P12` | Base64-encoded Developer ID Application `.p12` export |
| `MAC_CERTIFICATE_PASSWORD` | Password protecting the `.p12` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password created for notarization |
| `APPLE_TEAM_ID` | Developer team identifier |

The release workflow maps these secrets to electron-builder environment variables only on macOS jobs. The certificate and passwords are never printed or included in artifacts. Leave the secrets unset to create an explicitly unsigned build. Do not overwrite existing release assets to change a release's signing status; publish a new version after configuring signing.

## Verify a signed artifact

On a Mac, inspect the unpacked application with:

```sh
codesign --verify --deep --strict --verbose=2 /Applications/AgentTeam.app
codesign -dv --verbose=4 /Applications/AgentTeam.app
spctl --assess --type execute --verbose=2 /Applications/AgentTeam.app
xcrun stapler validate /Applications/AgentTeam.app
```

A successful build without credentials does not count as a Developer ID-signed/notarized release. The v0.1.0 signing status is stated in its release notes.
