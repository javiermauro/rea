import { describe, expect, it } from "vitest";
import {
  flipperStorageError,
  parseFlipperDeviceInfo,
  parseFlipperMd5,
  parseFlipperStorageList,
} from "./FlipperCliOutput.js";

describe("Flipper CLI output", () => {
  it("keeps device_info keys and values as printed, including empty values", () => {
    expect(
      parseFlipperDeviceInfo(
        "hardware_model                : Flipper Zero\r\nfirmware_origin_fork          : Momentum\r\nhardware_name                 : \r\n",
      ),
    ).toEqual({
      ok: true,
      value: [
        { key: "hardware_model", value: "Flipper Zero" },
        { key: "firmware_origin_fork", value: "Momentum" },
        { key: "hardware_name", value: "" },
      ],
    });
  });

  it("refuses device_info lines outside the key grammar", () => {
    expect(parseFlipperDeviceInfo("Usage: device_info\r\n")).toEqual({
      ok: false,
      line: "Usage: device_info",
    });
  });

  it("parses directories, files with spaces, sizes, and empty listings", () => {
    expect(
      parseFlipperStorageList(
        "\t[D] subghz\r\n\t[F] Samsung TV.ir 2418b\r\n\t[F] Manifest 180025b\r\n",
      ),
    ).toEqual({
      ok: true,
      value: [
        { name: "subghz", kind: "directory", bytes: null },
        { name: "Samsung TV.ir", kind: "file", bytes: 2418 },
        { name: "Manifest", kind: "file", bytes: 180025 },
      ],
    });
    expect(parseFlipperStorageList("\tEmpty\r\n")).toEqual({
      ok: true,
      value: [],
    });
  });

  it("refuses unrecognized listing lines instead of dropping them", () => {
    expect(parseFlipperStorageList("\t[X] odd\r\n")).toEqual({
      ok: false,
      line: "\t[X] odd",
    });
  });

  it("reads storage errors and md5 digests", () => {
    expect(flipperStorageError("Storage error: file/dir not exist\r\n")).toBe(
      "file/dir not exist",
    );
    expect(flipperStorageError("\t[D] subghz\r\n")).toBeUndefined();
    expect(parseFlipperMd5("3dafa17c77afd751c8a90646b59347c8\r\n")).toEqual({
      ok: true,
      value: "3dafa17c77afd751c8a90646b59347c8",
    });
    expect(parseFlipperMd5("not a digest\r\n").ok).toBe(false);
  });
});
