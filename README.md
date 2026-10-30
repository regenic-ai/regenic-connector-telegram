# regenic-connector-telegram

Local-first Telegram connector for Regenic.

## Platform and requirements

- macOS on Apple silicon is the currently verified runtime and native-build platform.
- Node.js 20 or newer, `gperf`, and CMake are required.
- TDLib is built locally from the pinned upstream commit documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The native library is not bundled.
- The connector uses the macOS Keychain for Telegram API credentials and the TDLib database encryption key. Other platforms fail closed; there is no plaintext key-file fallback.

## Build locally

```sh
npm ci
python3 -m pip install --target .local/build-tools cmake
npm run tdlib:build
npm run build
npm test
npm run tdlib:smoke
```

The TDLib build script checks the downloaded source archive against its pinned SHA-256 before building. It stores the source archive and library under the repository's ignored `.local/` directory. If the library is built elsewhere, set `REGENIC_TDLIB_LIBRARY` to its path before starting Regenic.

Load the built package as an external connector in the Regenic host, then install it from the connector catalog. It is not bundled into Regenic core.

## Sign in and select conversations

Use the local CLI from the repository after building:

```sh
node dist/cli.js login [profile-id]
node dist/cli.js chats [profile-id]
```

`login` interactively requests your Telegram API ID and API hash, then the phone number and any login code, email code, or two-step verification password required by Telegram. Input is hidden, the CLI requires a local interactive terminal, and credentials are stored in the macOS Keychain rather than connector configuration, command arguments, or environment variables.

`chats` lists conversation IDs and titles. In the Regenic install form, provide the profile ID used for login and only the conversation IDs you intend to synchronize. The connector does not auto-join conversations or select every chat.

## Data and lifecycle

The TDLib database and connector outbox are stored in a private local profile directory. The TDLib database uses an encryption key held in the macOS Keychain; the outbox is encrypted with AES-256-GCM. Credentials and message content are not sent through a Regenic cloud relay by this connector.

Disabling, deleting, or stopping an installation closes its local TDLib process. It does not sign the account out or delete its Keychain entries or local database. To explicitly sign out from Telegram, run `node dist/cli.js logout [profile-id]` and type `LOGOUT` at the confirmation prompt. That action is remote; it leaves the API credentials and local profile in place.

## Supported behavior and limitations

- Text-message history and incremental polling for explicitly selected private and group conversations.
- Text replies, including replies to a selected Telegram message.
- Local cursor persistence through Regenic's connector sync state, with message IDs used for deduplication and pagination.
- Media download and sending, secret chats, broadcast channels, group management, account creation, and automatic conversation joining are not supported.
- This is a signed-in Telegram user client. It does not provide Bot API behavior.
- Authentication states not handled by the local CLI are reported as unsupported rather than being silently skipped.

Use of Telegram's client API remains subject to [Telegram's API Terms](https://core.telegram.org/api/terms) and [Terms of Service](https://telegram.org/tos). Follow Telegram's limits and policies. Using TDLib does not guarantee account safety; this connector does not offer limit bypasses or bulk-messaging features.

## Validation

`npm test` runs local mapping, cursor, selection, outbox, send-result, and published connector-contract conformance tests. `npm run tdlib:smoke` calls TDLib's local JSON API without signing in or contacting a user account.
