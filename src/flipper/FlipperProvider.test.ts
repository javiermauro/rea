import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FlipperRequest } from "../domain/flipper/flipperDeviceAnalysis.js";
import { FlipperProvider } from "./FlipperProvider.js";
import type {
  FlipperSerialAccess,
  HostSerialPort,
} from "./FlipperSerialPort.js";

const FLIPPER: HostSerialPort = {
  path: "COM7",
  vendorId: "0483",
  productId: "5740",
  serialNumber: "flip_Test",
  manufacturer: "Flipper Devices Inc.",
};
const OTHER: HostSerialPort = {
  path: "COM3",
  vendorId: "1a86",
  productId: "7523",
  serialNumber: null,
  manufacturer: null,
};

/**
 * Scripted CLI that answers like Momentum/stock firmware: echo, output,
 * `\r\n>: ` prompt, and the `Size:`/`Ready?` handshake for read_chunks.
 */
const scriptedFlipper = (
  files: Record<string, Buffer>,
  options: { md5?: string; silent?: boolean } = {},
): FlipperSerialAccess & { readonly commands: string[] } => {
  const commands: string[] = [];
  return {
    commands,
    listPorts: async () => [OTHER, FLIPPER],
    openLink: async (_port, onData) => {
      const say = (text: string | Buffer) =>
        queueMicrotask(() =>
          onData(typeof text === "string" ? Buffer.from(text, "latin1") : text),
        );
      let line = "";
      let pending: { data: Buffer; offset: number; chunk: number } | undefined;
      if (!options.silent) say("Welcome\r\n\r\n>: ");
      return {
        close: async () => undefined,
        write: (bytes) => {
          const text = Buffer.from(bytes).toString("latin1");
          if (options.silent) return;
          if (pending !== undefined && text === "y") {
            const end = Math.min(
              pending.offset + pending.chunk,
              pending.data.length,
            );
            const block = pending.data.subarray(pending.offset, end);
            pending.offset = end;
            if (end < pending.data.length)
              say(Buffer.concat([block, Buffer.from("\r\nReady?\r\n")]));
            else {
              pending = undefined;
              say(Buffer.concat([block, Buffer.from("\r\n\r\n>: ")]));
            }
            return;
          }
          line += text;
          if (!line.endsWith("\r")) return;
          const command = line.slice(0, -1);
          line = "";
          if (command === "") {
            say("\r\n>: ");
            return;
          }
          commands.push(command);
          const path = /"([^"]*)"/u.exec(command)?.[1] ?? "";
          const echo = `${command}\r\n`;
          if (command === "device_info")
            say(
              `${echo}hardware_model                : Flipper Zero\r\nfirmware_origin_fork          : Momentum\r\n\r\n>: `,
            );
          else if (command.startsWith("storage list"))
            say(
              path === "/ext/subghz"
                ? `${echo}\t[D] remote\r\n\t[F] Gate Opener.sub 512b\r\n\r\n>: `
                : `${echo}Storage error: file/dir not exist\r\n\r\n>: `,
            );
          else if (command.startsWith("storage read_chunks")) {
            const data = files[path];
            if (data === undefined) {
              say(`${echo}Storage error: file/dir not exist\r\n\r\n>: `);
              return;
            }
            const chunk = Number(command.split(" ").at(-1));
            pending = { data, offset: 0, chunk };
            say(
              data.length === 0
                ? `${echo}Size: 0\r\n\r\n>: `
                : `${echo}Size: ${String(data.length)}\r\n\r\nReady?\r\n`,
            );
            if (data.length === 0) pending = undefined;
          } else if (command.startsWith("storage md5"))
            say(
              `${echo}${options.md5 ?? createHash("md5").update(files[path]!).digest("hex")}\r\n\r\n>: `,
            );
        },
      };
    },
  };
};

const run = (access: FlipperSerialAccess, request: FlipperRequest) =>
  new FlipperProvider({ serialAccess: async () => access }).execute(request);

const result = (outcome: Awaited<ReturnType<typeof run>>) => {
  if (!outcome.ok) throw outcome.error;
  return outcome.value.result;
};

describe("FlipperProvider", () => {
  it("lists only ports with the Flipper USB identity", async () => {
    expect(
      result(
        await run(scriptedFlipper({}), {
          operation: "list_flipper_devices",
          input: {},
        }),
      ),
    ).toEqual({
      devices: [
        {
          port: "COM7",
          serial_number: "flip_Test",
          manufacturer: "Flipper Devices Inc.",
        },
      ],
    });
  });

  it("refuses to open a port the host does not enumerate as a Flipper", async () => {
    const access = scriptedFlipper({});
    const outcome = await run(access, {
      operation: "inspect_flipper_device",
      input: { port: "COM3" },
    });
    expect(outcome.ok || outcome.error._tag).toBe(
      "AnalysisUnsupportedTargetError",
    );
    expect(access.commands).toEqual([]);
  });

  it("returns device_info properties without the echo or prompt", async () => {
    expect(
      result(
        await run(scriptedFlipper({}), {
          operation: "inspect_flipper_device",
          input: { port: "COM7" },
        }),
      ),
    ).toEqual({
      port: "COM7",
      properties: [
        { key: "hardware_model", value: "Flipper Zero" },
        { key: "firmware_origin_fork", value: "Momentum" },
      ],
    });
  });

  it("lists a directory and reports storage refusals as unsupported targets", async () => {
    const access = scriptedFlipper({});
    expect(
      result(
        await run(access, {
          operation: "list_flipper_directory",
          input: { port: "COM7", device_path: "/ext/subghz" },
        }),
      ),
    ).toMatchObject({
      entries: [
        { name: "remote", kind: "directory", bytes: null },
        { name: "Gate Opener.sub", kind: "file", bytes: 512 },
      ],
    });
    const missing = await run(access, {
      operation: "list_flipper_directory",
      input: { port: "COM7", device_path: "/ext/nope" },
    });
    expect(missing.ok || missing.error._tag).toBe(
      "AnalysisUnsupportedTargetError",
    );
    expect(access.commands).toEqual([
      'storage list "/ext/subghz"',
      'storage list "/ext/nope"',
    ]);
  });

  it("pulls binary content across chunk boundaries and verifies the device MD5", async () => {
    const data = Buffer.from(
      Array.from({ length: 2500 }, (_, index) => index % 256),
    );
    const directory = await mkdtemp(join(tmpdir(), "rea-flipper-"));
    const pulled = result(
      await run(scriptedFlipper({ "/ext/nfc/card.nfc": data }), {
        operation: "pull_flipper_file",
        input: {
          port: "COM7",
          device_path: "/ext/nfc/card.nfc",
          output_directory: directory,
        },
      }),
    );
    expect(pulled).toMatchObject({
      bytes: 2500,
      sha256: createHash("sha256").update(data).digest("hex"),
      device_md5: createHash("md5").update(data).digest("hex"),
    });
    expect((await readFile(join(directory, "card.nfc"))).equals(data)).toBe(
      true,
    );
  });

  it("removes the copy when the device MD5 disagrees", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-flipper-"));
    const outcome = await run(
      scriptedFlipper(
        { "/ext/a.ir": Buffer.from("x") },
        { md5: "0".repeat(32) },
      ),
      {
        operation: "pull_flipper_file",
        input: {
          port: "COM7",
          device_path: "/ext/a.ir",
          output_directory: directory,
        },
      },
    );
    expect(outcome.ok || outcome.error._tag).toBe("AnalysisProtocolError");
    expect(await readdir(directory)).toEqual([]);
  });

  it("never replaces an existing local file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-flipper-"));
    await writeFile(join(directory, "a.ir"), "mine");
    const access = scriptedFlipper({ "/ext/a.ir": Buffer.from("device") });
    const outcome = await run(access, {
      operation: "pull_flipper_file",
      input: {
        port: "COM7",
        device_path: "/ext/a.ir",
        output_directory: directory,
      },
    });
    expect(outcome.ok || outcome.error._tag).toBe("AnalysisOutputError");
    expect(await readFile(join(directory, "a.ir"), "utf8")).toBe("mine");
    expect(access.commands).toEqual([]);
  });
});

describe("FlipperProvider offline and availability", () => {
  it("decodes a local capture without loading serial access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-flipper-"));
    const path = join(directory, "badge.rfid");
    await writeFile(
      path,
      "Filetype: Flipper RFID key\nVersion: 1\nKey type: EM4100\nData: 01 00 0A 00 0B\n",
    );
    const provider = new FlipperProvider({
      serialAccess: () => Promise.reject(new Error("must not be loaded")),
    });
    const decoded = await provider.execute({
      operation: "inspect_flipper_capture",
      input: { path },
    });
    expect(result(decoded)).toMatchObject({
      bytes: 76,
      filetype: "Flipper RFID key",
      decoded: {
        format: "rfid",
        em4100: { facility_code: 10, card_number: 11 },
      },
    });
    const folder = await provider.execute({
      operation: "inspect_flipper_capture",
      input: { path: directory },
    });
    expect(folder.ok || folder.error._tag).toBe(
      "AnalysisUnsupportedTargetError",
    );
  });

  it("reports capability_unavailable when the serial binding cannot load", async () => {
    const provider = new FlipperProvider({
      serialAccess: () => Promise.reject(new Error("no prebuilt binding")),
    });
    const outcome = await provider.execute({
      operation: "list_flipper_devices",
      input: {},
    });
    expect(outcome.ok || outcome.error._tag).toBe(
      "AnalysisCapabilityUnavailableError",
    );
    expect((await provider.inspectAvailability()).status).toBe("unavailable");
  });
});
