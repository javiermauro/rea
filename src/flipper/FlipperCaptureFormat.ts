import type { FlipperCapture } from "../domain/flipper/flipperDeviceAnalysis.js";

/**
 * Decode Flipper Format capture files (`Filetype:`/`Version:` header followed
 * by `Key: value` lines, `#` separating infrared signals). Values stay as
 * stored; numbers, modulation, NDEF records, and EM4100 fields are derived.
 * Bulk timing data is summarized, never echoed.
 */
export const decodeFlipperCapture = (
  text: string,
): Omit<FlipperCapture, "local_path" | "bytes" | "sha256"> => {
  const lines: { key: string; value: string }[] = [];
  const issues: { line: number; text: string }[] = [];
  text.split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") return;
    if (line.startsWith("#")) {
      lines.push({ key: "#", value: "" });
      return;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      issues.push({ line: index + 1, text: line.slice(0, 120) });
      return;
    }
    lines.push({
      key: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
    });
  });
  const first = (key: string): string | null =>
    lines.find((line) => line.key === key)?.value ?? null;
  const filetype = first("Filetype");
  const versionText = first("Version");
  const references = [
    ...new Set(
      lines
        .map(({ value }) => value)
        .filter((value) => /^\/(?:ext|int)\//u.test(value)),
    ),
  ];
  return {
    filetype,
    version:
      versionText !== null && /^\d+$/u.test(versionText)
        ? Number(versionText)
        : null,
    decoded: decodeByFiletype(filetype, lines, first),
    references,
    unparsed_lines: issues.slice(0, 10),
    unparsed_line_count: issues.length,
  };
};

type Line = { key: string; value: string };

const decodeByFiletype = (
  filetype: string | null,
  lines: Line[],
  first: (key: string) => string | null,
): FlipperCapture["decoded"] => {
  switch (filetype) {
    case "IR signals file":
    case "IR library file":
      return { format: "infrared", signals: infraredSignals(lines) };
    case "Flipper SubGhz Key File":
    case "Flipper SubGhz RAW File":
      return subGhz(lines, first);
    case "Flipper NFC device":
      return nfc(lines, first);
    case "Flipper RFID key":
      return rfid(first);
    case "Flipper iButton key":
      return {
        format: "ibutton",
        protocol: first("Protocol") ?? first("Key type"),
        data: first("Rom Data") ?? first("Data"),
      };
    default:
      return { format: "other" };
  }
};

/** Little-endian hex bytes as stored (`07 00 00 00`) to an integer. */
const littleEndian = (hex: string | null): number | null => {
  if (hex === null || !/^(?:[0-9A-Fa-f]{2} ?)+$/u.test(hex)) return null;
  const bytes = hex
    .trim()
    .split(/\s+/u)
    .map((byte) => parseInt(byte, 16));
  return bytes.reduceRight((value, byte) => value * 256 + byte, 0);
};

/** A stored number, or null when the key is absent or the value does not qualify. */
const stored = (
  value: string | null,
  accept: (number: number) => boolean,
): number | null => {
  if (value === null || value.trim() === "") return null;
  const number = Number(value);
  return accept(number) ? number : null;
};

/** Timing lists: counts and total duration of mark/space microseconds. */
const timings = (values: string[]) => {
  let count = 0;
  let durationUs = 0;
  for (const value of values)
    for (const token of value.split(/\s+/u)) {
      const timing = Number(token);
      if (token === "" || !Number.isFinite(timing)) continue;
      count += 1;
      durationUs += Math.abs(timing);
    }
  return { count, duration_us: durationUs };
};

const infraredSignals = (lines: Line[]) => {
  const signals: Extract<
    FlipperCapture["decoded"],
    { format: "infrared" }
  >["signals"] = [];
  let current: Line[] = [];
  const flush = () => {
    const get = (key: string) =>
      current.find((line) => line.key === key)?.value ?? null;
    const name = get("name");
    if (name !== null) {
      if (get("type") === "raw") {
        signals.push({
          name,
          type: "raw",
          frequency_hz: stored(get("frequency"), Number.isFinite),
          duty_cycle: stored(get("duty_cycle"), Number.isFinite),
          timings: timings(
            current
              .filter(({ key }) => key === "data")
              .map(({ value }) => value),
          ),
        });
      } else
        signals.push({
          name,
          type: "parsed",
          protocol: get("protocol"),
          address: get("address"),
          command: get("command"),
          address_value: littleEndian(get("address")),
          command_value: littleEndian(get("command")),
        });
    }
    current = [];
  };
  for (const line of lines) {
    if (
      line.key === "#" ||
      (line.key === "name" && current.some(({ key }) => key === "name"))
    )
      flush();
    if (line.key !== "#") current.push(line);
  }
  flush();
  return signals;
};

/** Built-in CC1101 presets; the label is derived from the preset name. */
const PRESET_MODULATION: Record<string, string> = {
  FuriHalSubGhzPresetOok270Async: "AM/OOK, 270 kHz bandwidth",
  FuriHalSubGhzPresetOok650Async: "AM/OOK, 650 kHz bandwidth",
  FuriHalSubGhzPreset2FSKDev238Async: "FM/2-FSK, 2.38 kHz deviation",
  FuriHalSubGhzPreset2FSKDev476Async: "FM/2-FSK, 47.6 kHz deviation",
  FuriHalSubGhzPresetMSK99_97KbAsync: "MSK, 99.97 kBaud",
  FuriHalSubGhzPresetGFSK9_99KbAsync: "GFSK, 9.99 kBaud",
  FuriHalSubGhzPresetCustom: "custom CC1101 register preset",
};

const subGhz = (
  lines: Line[],
  first: (key: string) => string | null,
): FlipperCapture["decoded"] => {
  const preset = first("Preset");
  const raw = lines
    .filter(({ key }) => key === "RAW_Data")
    .map(({ value }) => value);
  return {
    format: "subghz",
    frequency_hz: stored(first("Frequency"), Number.isInteger),
    preset,
    modulation: preset === null ? null : (PRESET_MODULATION[preset] ?? null),
    protocol: first("Protocol"),
    bits: stored(first("Bit"), Number.isInteger),
    key: first("Key"),
    te_us: stored(first("TE"), Number.isInteger),
    raw_timings: raw.length === 0 ? null : timings(raw),
  };
};

const nfc = (
  lines: Line[],
  first: (key: string) => string | null,
): FlipperCapture["decoded"] => {
  const memory = lines.filter(({ key }) => /^(?:Block|Page) \d+$/u.test(key));
  return {
    format: "nfc",
    device_type: first("Device type"),
    uid: first("UID"),
    atqa: first("ATQA"),
    sak: first("SAK"),
    memory_units_total: stored(
      first("Pages total") ?? first("Blocks total"),
      Number.isInteger,
    ),
    memory_units_read: memory.filter(({ value }) => !value.includes("??"))
      .length,
    memory_units_unread: memory.filter(({ value }) => value.includes("??"))
      .length,
    ndef_records: memory.some(({ key }) => key.startsWith("Page "))
      ? ndefRecords(memory)
      : [],
  };
};

/** URI identifier codes from NFC Forum RTD-URI 1.0, table 3. */
const URI_PREFIXES = [
  "",
  "http://www.",
  "https://www.",
  "http://",
  "https://",
  "tel:",
  "mailto:",
  "ftp://anonymous:anonymous@",
  "ftp://ftp.",
  "ftps://",
  "sftp://",
  "smb://",
  "nfs://",
  "ftp://",
  "dav://",
  "news:",
  "telnet://",
  "imap:",
  "rtsp://",
  "urn:",
  "pop:",
  "sip:",
  "sips:",
  "tftp:",
  "btspp://",
  "btl2cap://",
  "btgoep://",
  "tcpobex://",
  "irdaobex://",
  "file://",
  "urn:epc:id:",
  "urn:epc:tag:",
  "urn:epc:pat:",
  "urn:epc:raw:",
  "urn:epc:",
  "urn:nfc:",
];

type NdefRecord = Extract<
  FlipperCapture["decoded"],
  { format: "nfc" }
>["ndef_records"][number];

/** NFC Forum Type 2 tag: TLVs from page 4, NDEF message TLV 0x03. */
const ndefRecords = (pages: Line[]): NdefRecord[] => {
  const bytes: number[] = [];
  for (const { key, value } of pages) {
    if (Number(key.slice(5)) < 4) continue;
    if (value.includes("??")) break;
    bytes.push(...value.split(/\s+/u).map((byte) => parseInt(byte, 16)));
  }
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset]!;
    if (tag === 0x00) {
      offset += 1;
      continue;
    }
    if (tag === 0xfe) break;
    let length = bytes[offset + 1] ?? 0;
    let start = offset + 2;
    if (length === 0xff) {
      length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
      start = offset + 4;
    }
    if (tag === 0x03) return ndefMessage(bytes.slice(start, start + length));
    offset = start + length;
  }
  return [];
};

const ndefMessage = (message: number[]): NdefRecord[] => {
  const records: NdefRecord[] = [];
  let offset = 0;
  while (offset + 3 <= message.length && records.length < 16) {
    const flags = message[offset]!;
    const shortRecord = (flags & 0x10) !== 0;
    const hasId = (flags & 0x08) !== 0;
    const typeLength = message[offset + 1]!;
    let cursor = offset + 2;
    let payloadLength: number;
    if (shortRecord) payloadLength = message[cursor++] ?? 0;
    else {
      payloadLength = message
        .slice(cursor, cursor + 4)
        .reduce((value, byte) => value * 256 + byte, 0);
      cursor += 4;
    }
    const idLength = hasId ? (message[cursor++] ?? 0) : 0;
    const type = String.fromCharCode(
      ...message.slice(cursor, cursor + typeLength),
    );
    cursor += typeLength + idLength;
    const payload = message.slice(cursor, cursor + payloadLength);
    const tnf = flags & 0x07;
    if (tnf === 1 && type === "U" && payload.length > 0)
      records.push({
        type: "uri",
        value:
          (URI_PREFIXES[payload[0]!] ?? "") +
          Buffer.from(payload.slice(1)).toString("utf8"),
      });
    else if (tnf === 1 && type === "T" && payload.length > 0) {
      const languageLength = payload[0]! & 0x3f;
      records.push({
        type: "text",
        value: Buffer.from(payload.slice(1 + languageLength)).toString(
          (payload[0]! & 0x80) === 0 ? "utf8" : "utf16le",
        ),
      });
    } else
      records.push({
        type: "other",
        value: `TNF ${String(tnf)}, type ${JSON.stringify(type)}`,
      });
    if ((flags & 0x40) !== 0) break;
    offset = cursor + payloadLength;
  }
  return records;
};

const rfid = (
  first: (key: string) => string | null,
): FlipperCapture["decoded"] => {
  const keyType = first("Key type");
  const data = first("Data");
  const bytes = data?.split(/\s+/u).map((byte) => parseInt(byte, 16)) ?? [];
  const em4100 =
    keyType === "EM4100" &&
    bytes.length === 5 &&
    bytes.every((byte) => byte >= 0 && byte <= 255)
      ? {
          version_byte: bytes[0]!,
          card_id: bytes
            .slice(1)
            .reduce((value, byte) => value * 256 + byte, 0),
          facility_code: bytes[2]!,
          card_number: bytes[3]! * 256 + bytes[4]!,
        }
      : null;
  return { format: "rfid", key_type: keyType, data, em4100 };
};
