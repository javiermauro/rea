# Flipper Zero device inspection and acquisition

REA inspects a Flipper Zero attached over USB and copies files from its
storage through the firmware's serial CLI. Captures saved by the Sub-GHz,
Infrared, NFC, 125 kHz RFID and iButton apps become host files, and
`inspect_flipper_capture` decodes them offline.

The provider is read-only with respect to the device. It sends only fixed
commands — `device_info`, `storage list`, `storage read_chunks` and
`storage md5` — and never writes device storage, starts an app or drives a
radio. Stock and fork firmware (Momentum, Unleashed, RogueMaster) share these
commands.

## Supply tools

Serial access uses the `serialport` package and its prebuilt native binding,
installed with REA. A host without a usable binding reports the `flipper`
family as `capability_unavailable` instead of failing startup.

Close qFlipper, lab.flipper.net and other serial terminals first: a serial
port has one owner at a time. Leave the Flipper on its desktop screen; some
apps hold the CLI while they run.

## Answer an analyst question

```sh
rea list-flipper-devices
rea inspect-flipper-device COM7
rea list-flipper-directory COM7 /ext/infrared
rea pull-flipper-file COM7 /ext/infrared/TV.ir --output-directory ./captures
rea inspect-flipper-capture ./captures/TV.ir
```

Equivalent MCP methods use the snake_case names (`list_flipper_devices`,
`inspect_flipper_device`, `list_flipper_directory`, `pull_flipper_file`,
`inspect_flipper_capture`).
Device operations take `port` exactly as `list_flipper_devices` reports it:
`COM7` on Windows, `/dev/ttyACM0` on Linux, `/dev/cu.usbmodemflip_<name>1` on
macOS.

## Operations

| Tool                      | What it does                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `list_flipper_devices`    | Lists ports the host enumerates with USB identity `0483:5740`. Opens no port.                   |
| `inspect_flipper_device`  | Returns `device_info` keys and values as printed: hardware, region, firmware, fork, API, radio. |
| `list_flipper_directory`  | Lists one `/ext` or `/int` directory: names, file or directory kind, file sizes.                |
| `pull_flipper_file`       | Copies one file to a new local file and verifies it against the device MD5.                     |
| `inspect_flipper_capture` | Decodes one local capture file offline; never contacts a device.                                |

## Interpret the result

- **Port identity is checked before any byte is sent.** A port the host does
  not enumerate with the Flipper USB identity is refused as an unsupported
  target, so REA never writes CLI commands to another serial device.
- **Paths are single CLI arguments.** Device paths must start with `/ext` or
  `/int` and cannot contain control characters or double quotes; REA sends
  them quoted and refuses rather than escapes anything else.
- **Pulls are verified end to end.** `storage read_chunks` transfers raw
  bytes, so binary files survive intact. After the transfer REA compares the
  local MD5 with the device's `storage md5`; a mismatch removes the copy and
  reports a protocol failure. Results carry the local SHA-256 and the device
  MD5. An existing local file is never replaced.
- **Storage refusals are target facts.** `Storage error: file/dir not exist`
  and similar CLI refusals report an unsupported target with the CLI reason.

## Decode captures

`inspect_flipper_capture` reads Flipper Format files: a `Filetype:` and
`Version:` header followed by `Key: value` lines.

| Filetype                                             | Decoded facts                                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IR signals file`, `IR library file`                 | Each signal: protocol, stored address and command bytes with their little-endian values; raw signals report carrier frequency, duty cycle, and a timing count and total duration. |
| `Flipper SubGhz Key File`, `Flipper SubGhz RAW File` | Frequency, preset with a modulation label for built-in CC1101 presets, protocol, bit count, key, TE; RAW files report a timing count and total duration.                          |
| `Flipper NFC device`                                 | Device type, UID, ATQA, SAK, read and unread (`??`) blocks or pages, and NFC Forum Type 2 NDEF URI and text records.                                                              |
| `Flipper RFID key`                                   | Key type and data; EM4100 data also yields version byte, card ID, facility code, and card number.                                                                                 |
| `Flipper iButton key`                                | Protocol or key type and data, for format versions 1 and 2.                                                                                                                       |

Every file also reports the `/ext` and `/int` paths it names, which covers
remote maps and playlists that have no `Filetype` header, plus the first ten
lines outside the `Key: value` grammar and their total. Stored values are kept
as written; numbers, modulation labels, NDEF records, and EM4100 fields are
derived. Timing data is summarized and never echoed. Files are limited to
32 MiB.

## Resource and lifecycle limits

Inspection and listing share a 15-second deadline; a pull has 10 minutes.
Transfers move 1 KiB per acknowledgement, about 60 KB/s over USB, so a
deadline bounds file size in practice. Every exchange waits for the CLI
prompt, and the port is closed after each operation; cancellation closes it
at once and removes a partial copy.

## Real verification

Verified on Windows 11 with a Flipper Zero (hardware 12, region US) running
Momentum `mntm-012` (API 87.1): device listing, `device_info`, directory
listing, missing-path refusal, non-Flipper port refusal, and pulls of a
2,418-byte infrared file and a 180,025-byte binary manifest, each matching
the device MD5.
