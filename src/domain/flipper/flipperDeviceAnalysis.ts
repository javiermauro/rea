import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";

/** USB identity the Flipper Zero firmware reports for its CDC serial CLI. */
export const FLIPPER_USB_VENDOR_ID = "0483";
export const FLIPPER_USB_PRODUCT_ID = "5740";

/**
 * Host serial port as the operating system names it (`COM7`,
 * `/dev/ttyACM0`, `/dev/cu.usbmodemflip_Name1`). The provider only opens a
 * port the host enumerates with the Flipper USB identity.
 */
const portSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}"']+$/u, "Port cannot contain control characters")
  .describe("Serial port exactly as `list_flipper_devices` reports it");

/**
 * Flipper storage path. Every command is one CLI line, so control characters
 * (a newline would start a second command) and double quotes (the path is
 * sent quoted) are refused rather than escaped.
 */
const flipperPathSchema = z
  .string()
  .min(4)
  .max(512)
  .regex(
    /^\/(?:ext|int)(?:\/[^\p{Cc}"]*)?$/u,
    "Flipper path must start with /ext or /int and cannot contain control characters or double quotes",
  );

/** Caller intent for Flipper Zero inspection over its USB serial CLI. */
export const flipperInputSchemas = {
  list_flipper_devices: z.strictObject({}),
  inspect_flipper_device: z.strictObject({ port: portSchema }),
  list_flipper_directory: z.strictObject({
    port: portSchema,
    device_path: flipperPathSchema.describe(
      "Absolute Flipper directory such as /ext/subghz",
    ),
  }),
  pull_flipper_file: z.strictObject({
    port: portSchema,
    device_path: flipperPathSchema.describe(
      "Absolute Flipper file path such as /ext/infrared/TV.ir",
    ),
    output_directory: localPathStringSchema.describe(
      "Local directory for the pulled file; must not already contain the file",
    ),
  }),
  inspect_flipper_capture: z.strictObject({
    path: localPathStringSchema.describe(
      "Local Flipper capture file (.sub, .ir, .nfc, .rfid, .ibtn), for example from pull_flipper_file",
    ),
  }),
} as const;

/** Supported Flipper operations. */
export type FlipperOperation = keyof typeof flipperInputSchemas;
/** Validated Flipper requests carry their selected operation. */
export type FlipperRequest = {
  [Name in FlipperOperation]: {
    operation: Name;
    input: z.infer<(typeof flipperInputSchemas)[Name]>;
  };
}[FlipperOperation];

/** Validate operation and input together so their types remain correlated. */
export const flipperRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("list_flipper_devices"),
    input: flipperInputSchemas.list_flipper_devices,
  }),
  z.strictObject({
    operation: z.literal("inspect_flipper_device"),
    input: flipperInputSchemas.inspect_flipper_device,
  }),
  z.strictObject({
    operation: z.literal("list_flipper_directory"),
    input: flipperInputSchemas.list_flipper_directory,
  }),
  z.strictObject({
    operation: z.literal("pull_flipper_file"),
    input: flipperInputSchemas.pull_flipper_file,
  }),
  z.strictObject({
    operation: z.literal("inspect_flipper_capture"),
    input: flipperInputSchemas.inspect_flipper_capture,
  }),
]);

const timingSummary = z.strictObject({
  count: z.int().nonnegative(),
  /** Sum of absolute mark/space durations. */
  duration_us: z.number().nonnegative(),
});

/** Decoded capture by format; stored values stay as written, numbers are derived. */
const decodedCapture = z.discriminatedUnion("format", [
  z.strictObject({
    format: z.literal("infrared"),
    signals: z.array(
      z.discriminatedUnion("type", [
        z.strictObject({
          name: z.string(),
          type: z.literal("parsed"),
          protocol: z.string().nullable(),
          address: z.string().nullable(),
          command: z.string().nullable(),
          /** Little-endian value of the stored address bytes. */
          address_value: z.number().nullable(),
          command_value: z.number().nullable(),
        }),
        z.strictObject({
          name: z.string(),
          type: z.literal("raw"),
          frequency_hz: z.number().nullable(),
          duty_cycle: z.number().nullable(),
          timings: timingSummary,
        }),
      ]),
    ),
  }),
  z.strictObject({
    format: z.literal("subghz"),
    frequency_hz: z.int().nullable(),
    preset: z.string().nullable(),
    /** Derived from built-in CC1101 preset names; null when unrecognized. */
    modulation: z.string().nullable(),
    protocol: z.string().nullable(),
    bits: z.int().nullable(),
    key: z.string().nullable(),
    te_us: z.int().nullable(),
    /** RAW_Data summary; null for decoded key files. */
    raw_timings: timingSummary.nullable(),
  }),
  z.strictObject({
    format: z.literal("nfc"),
    device_type: z.string().nullable(),
    uid: z.string().nullable(),
    atqa: z.string().nullable(),
    sak: z.string().nullable(),
    memory_units_total: z.int().nullable(),
    memory_units_read: z.int().nonnegative(),
    /** Blocks or pages stored as `??`: the reader lacked their keys. */
    memory_units_unread: z.int().nonnegative(),
    /** Type 2 tag NDEF records decoded from page data. */
    ndef_records: z.array(
      z.strictObject({
        type: z.enum(["uri", "text", "other"]),
        value: z.string(),
      }),
    ),
  }),
  z.strictObject({
    format: z.literal("rfid"),
    key_type: z.string().nullable(),
    data: z.string().nullable(),
    /** EM4100 fields derived from the five stored bytes. */
    em4100: z
      .strictObject({
        version_byte: z.int(),
        card_id: z.int(),
        facility_code: z.int(),
        card_number: z.int(),
      })
      .nullable(),
  }),
  z.strictObject({
    format: z.literal("ibutton"),
    protocol: z.string().nullable(),
    data: z.string().nullable(),
  }),
  z.strictObject({ format: z.literal("other") }),
]);

const capture = z.strictObject({
  local_path: z.string().min(1),
  bytes: z.int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  filetype: z.string().nullable(),
  version: z.int().nullable(),
  decoded: decodedCapture,
  /** Flipper storage paths the file names, such as remote maps and playlists. */
  references: z.array(z.string()),
  /** First ten lines outside the `Key: value` grammar. */
  unparsed_lines: z.array(
    z.strictObject({ line: z.int().positive(), text: z.string() }),
  ),
  unparsed_line_count: z.int().nonnegative(),
});

export type FlipperCapture = z.infer<typeof capture>;

const device = z.strictObject({
  port: z.string().min(1),
  /** USB serial number, `flip_<name>` on stock and fork firmware. */
  serial_number: z.string().min(1).nullable(),
  manufacturer: z.string().min(1).nullable(),
});

const directoryEntry = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(["file", "directory"]),
  /** Size the CLI printed for files; directories report none. */
  bytes: z.int().nonnegative().nullable(),
});

/** Results retain the CLI's own key names and values without renaming them. */
export const flipperResultSchemas = {
  list_flipper_devices: z.strictObject({
    devices: z.array(device),
  }),
  inspect_flipper_device: z.strictObject({
    port: z.string().min(1),
    /** `device_info` lines in CLI order; values are kept as printed. */
    properties: z.array(
      z.strictObject({ key: z.string().min(1), value: z.string() }),
    ),
  }),
  list_flipper_directory: z.strictObject({
    port: z.string().min(1),
    device_path: z.string().min(1),
    entries: z.array(directoryEntry),
  }),
  pull_flipper_file: z.strictObject({
    port: z.string().min(1),
    device_path: z.string().min(1),
    local_path: z.string().min(1),
    bytes: z.int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    /** Device-computed `storage md5`, matched against the local copy. */
    device_md5: z.string().regex(/^[a-f0-9]{32}$/u),
  }),
  inspect_flipper_capture: capture,
} as const;

export type FlipperDevice = z.infer<typeof device>;
export type FlipperDirectoryEntry = z.infer<typeof directoryEntry>;
