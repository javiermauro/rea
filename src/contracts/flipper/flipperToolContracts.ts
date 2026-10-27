import {
  flipperInputSchemas,
  flipperResultSchemas,
} from "../../domain/flipper/flipperDeviceAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Flipper Zero inspection and file acquisition over its USB serial CLI. */
export const FLIPPER_TOOL_CONTRACTS = [
  {
    name: "list_flipper_devices",
    ...toolContractMetadata("list_flipper_devices"),
    description:
      "List Flipper Zero devices attached over USB: serial port, USB serial number, and manufacturer. Only ports the host enumerates with the Flipper USB identity 0483:5740 appear; no port is opened.",
    kind: "flipper-provider",
    inputSchema: flipperInputSchemas.list_flipper_devices,
    outputSchema: evidenceResultOf(flipperResultSchemas.list_flipper_devices),
    examples: [{ title: "List attached Flipper devices", input: {} }],
  },
  {
    name: "inspect_flipper_device",
    ...toolContractMetadata("inspect_flipper_device"),
    description:
      "Inspect one Flipper's identity through the CLI `device_info` command: hardware model and revision, region, firmware version, branch, fork origin, API version, and radio stack. Keys and values are kept exactly as printed. Read-only with respect to the device.",
    kind: "flipper-provider",
    inputSchema: flipperInputSchemas.inspect_flipper_device,
    outputSchema: evidenceResultOf(flipperResultSchemas.inspect_flipper_device),
    examples: [{ title: "Inspect one Flipper", input: { port: "COM7" } }],
  },
  {
    name: "list_flipper_directory",
    ...toolContractMetadata("list_flipper_directory"),
    description:
      "List one Flipper storage directory (under /ext or /int) through `storage list`: entry names, file or directory kind, and file sizes. Captures live under /ext/subghz, /ext/infrared, /ext/nfc, /ext/lfrfid, and /ext/ibutton. Read-only.",
    kind: "flipper-provider",
    inputSchema: flipperInputSchemas.list_flipper_directory,
    outputSchema: evidenceResultOf(flipperResultSchemas.list_flipper_directory),
    examples: [
      {
        title: "List Sub-GHz captures",
        input: { port: "COM7", device_path: "/ext/subghz" },
      },
    ],
  },
  {
    name: "pull_flipper_file",
    ...toolContractMetadata("pull_flipper_file"),
    description:
      "Copy one Flipper storage file to a new local file through the binary-safe `storage read_chunks` exchange, then verify it against the device-computed `storage md5`. Returns the local path, size, SHA-256, and device MD5. Never overwrites a local file; the device keeps its original.",
    kind: "flipper-provider",
    inputSchema: flipperInputSchemas.pull_flipper_file,
    outputSchema: evidenceResultOf(flipperResultSchemas.pull_flipper_file),
    examples: [
      {
        title: "Pull an infrared remote file",
        input: {
          port: "COM7",
          device_path: "/ext/infrared/TV.ir",
          output_directory: "/tmp/flipper",
        },
      },
    ],
  },
  {
    name: "inspect_flipper_capture",
    ...toolContractMetadata("inspect_flipper_capture"),
    description:
      "Decode one local Flipper capture file offline: Sub-GHz frequency, modulation, protocol, bit count, key, and RAW timing summary; infrared signals with protocol, address, and command; NFC type, UID, ATQA/SAK, unread blocks, and Type 2 NDEF URI/text records; 125 kHz RFID key with EM4100 facility and card number; iButton data; and Flipper paths the file references. Bulk timing data is summarized, not echoed. Never contacts a device.",
    kind: "flipper-provider",
    inputSchema: flipperInputSchemas.inspect_flipper_capture,
    outputSchema: evidenceResultOf(
      flipperResultSchemas.inspect_flipper_capture,
    ),
    examples: [
      {
        title: "Decode a pulled infrared remote",
        input: { path: "/tmp/flipper/TV.ir" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
