import { describe, expect, it } from "vitest";
import { decodeFlipperCapture } from "./FlipperCaptureFormat.js";

describe("decodeFlipperCapture radio formats", () => {
  it("decodes parsed and raw infrared signals with little-endian values", () => {
    const capture = decodeFlipperCapture(
      [
        "Filetype: IR signals file",
        "Version: 1",
        "# ",
        "name: POWER",
        "type: parsed",
        "protocol: Samsung32",
        "address: 07 00 00 00",
        "command: 02 01 00 00",
        "# ",
        "name: Fan",
        "type: raw",
        "frequency: 38000",
        "duty_cycle: 0.330000",
        "data: 9000 4500 560 1690",
        "",
      ].join("\r\n"),
    );
    expect(capture).toMatchObject({ filetype: "IR signals file", version: 1 });
    expect(capture.decoded).toEqual({
      format: "infrared",
      signals: [
        {
          name: "POWER",
          type: "parsed",
          protocol: "Samsung32",
          address: "07 00 00 00",
          command: "02 01 00 00",
          address_value: 7,
          command_value: 0x0102,
        },
        {
          name: "Fan",
          type: "raw",
          frequency_hz: 38000,
          duty_cycle: 0.33,
          timings: { count: 4, duration_us: 15750 },
        },
      ],
    });
  });

  it("summarizes Sub-GHz RAW timing without echoing it and labels the preset", () => {
    const capture = decodeFlipperCapture(
      [
        "Filetype: Flipper SubGhz RAW File",
        "Version: 1",
        "Frequency: 315000000",
        "Preset: FuriHalSubGhzPresetOok650Async",
        "Protocol: RAW",
        "RAW_Data: 400 -400 800",
        "RAW_Data: -1200",
      ].join("\n"),
    );
    expect(capture.decoded).toEqual({
      format: "subghz",
      frequency_hz: 315000000,
      preset: "FuriHalSubGhzPresetOok650Async",
      modulation: "AM/OOK, 650 kHz bandwidth",
      protocol: "RAW",
      bits: null,
      key: null,
      te_us: null,
      raw_timings: { count: 4, duration_us: 2800 },
    });
    expect(JSON.stringify(capture)).not.toContain("-1200");
  });

  it("decodes a Sub-GHz key file", () => {
    expect(
      decodeFlipperCapture(
        "Filetype: Flipper SubGhz Key File\nVersion: 1\nFrequency: 433920000\nPreset: FuriHalSubGhzPresetCustom\nProtocol: Princeton\nBit: 24\nKey: 00 00 00 00 00 95 D5 D4\nTE: 400\n",
      ).decoded,
    ).toMatchObject({
      format: "subghz",
      modulation: "custom CC1101 register preset",
      protocol: "Princeton",
      bits: 24,
      key: "00 00 00 00 00 95 D5 D4",
      te_us: 400,
      raw_timings: null,
    });
  });
});

describe("decodeFlipperCapture card and reference formats", () => {
  it("decodes NFC identity, unread blocks, and a Type 2 NDEF URI", () => {
    // TLV 03 (NDEF), record D1 01 <len> 'U' 04 "example.com/x", then FE.
    const uri = Buffer.from("example.com/x", "latin1");
    const ndef = [
      0x03,
      uri.length + 5,
      0xd1,
      0x01,
      uri.length + 1,
      0x55,
      0x04,
      ...uri,
      0xfe,
    ];
    while (ndef.length % 4 !== 0) ndef.push(0);
    const pages = Array.from(
      { length: ndef.length / 4 },
      (_, index) =>
        `Page ${String(index + 4)}: ${ndef
          .slice(index * 4, index * 4 + 4)
          .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
          .join(" ")}`,
    );
    const capture = decodeFlipperCapture(
      [
        "Filetype: Flipper NFC device",
        "Version: 4",
        "Device type: NTAG215",
        "UID: 04 11 22 33 44 55 66",
        "ATQA: 44 00",
        "SAK: 00",
        "Pages total: 135",
        "Page 0: 04 11 22 B9",
        "Page 1: 33 44 55 66",
        "Page 2: 00 48 00 00",
        "Page 3: E1 10 3E 00",
        ...pages,
        "Page 99: ?? ?? ?? ??",
      ].join("\n"),
    );
    expect(capture.decoded).toEqual({
      format: "nfc",
      device_type: "NTAG215",
      uid: "04 11 22 33 44 55 66",
      atqa: "44 00",
      sak: "00",
      memory_units_total: 135,
      memory_units_read: 4 + pages.length,
      memory_units_unread: 1,
      ndef_records: [{ type: "uri", value: "https://example.com/x" }],
    });
  });

  it("derives EM4100 facility and card number from RFID data", () => {
    expect(
      decodeFlipperCapture(
        "Filetype: Flipper RFID key\nVersion: 1\nKey type: EM4100\nData: 4D 00 3E 1A AB\n",
      ).decoded,
    ).toEqual({
      format: "rfid",
      key_type: "EM4100",
      data: "4D 00 3E 1A AB",
      em4100: {
        version_byte: 0x4d,
        card_id: 0x003e1aab,
        facility_code: 62,
        card_number: 6827,
      },
    });
  });

  it("reads both iButton format versions", () => {
    expect(
      decodeFlipperCapture(
        "Filetype: Flipper iButton key\nVersion: 2\nProtocol: DS1990\nRom Data: 01 02 03 04 05 06 07 08\n",
      ).decoded,
    ).toEqual({
      format: "ibutton",
      protocol: "DS1990",
      data: "01 02 03 04 05 06 07 08",
    });
    expect(
      decodeFlipperCapture(
        "Filetype: Flipper iButton key\nVersion: 1\nKey type: Cyfral\nData: A1 B2\n",
      ).decoded,
    ).toEqual({ format: "ibutton", protocol: "Cyfral", data: "A1 B2" });
  });

  it("keeps references and unparsed lines for files without a known filetype", () => {
    const capture = decodeFlipperCapture(
      "sub: /ext/subghz/a.sub\nsub: /ext/subghz/a.sub\nREMOTE: /ext/infrared/TV.ir\nnot a pair\n",
    );
    expect(capture).toMatchObject({
      filetype: null,
      version: null,
      decoded: { format: "other" },
      references: ["/ext/subghz/a.sub", "/ext/infrared/TV.ir"],
      unparsed_lines: [{ line: 4, text: "not a pair" }],
      unparsed_line_count: 1,
    });
  });
});
