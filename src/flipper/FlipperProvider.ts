import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
  type ProviderAvailability,
} from "../application/AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  FLIPPER_USB_PRODUCT_ID,
  FLIPPER_USB_VENDOR_ID,
  type FlipperDevice,
  type FlipperOperation,
  type FlipperRequest,
} from "../domain/flipper/flipperDeviceAnalysis.js";
import { err, ok, type Result } from "../domain/result.js";
import { adbHostFileName } from "../adb/AdbHostFileName.js";
import {
  absoluteCallerPath,
  appendCallerPath,
} from "../filesystem/callerPath.js";
import {
  flipperStorageError,
  parseFlipperDeviceInfo,
  parseFlipperMd5,
  parseFlipperStorageList,
  type FlipperParse,
} from "./FlipperCliOutput.js";
import { decodeFlipperCapture } from "./FlipperCaptureFormat.js";
import {
  FlipperCliSession,
  FlipperTransportFailure,
} from "./FlipperCliSession.js";
import {
  loadSerialportAccess,
  type FlipperSerialAccess,
} from "./FlipperSerialPort.js";

/** Stable identity for the Flipper Zero serial CLI provider. */
export const FLIPPER_PROVIDER_IDENTITY = {
  id: "flipper",
  name: "Flipper Zero serial CLI",
  version: null,
} as const;

const COMMAND_TIMEOUT_MS = 15_000;
const PULL_TIMEOUT_MS = 600_000;
/** Block size per `Ready?` acknowledgement; the firmware allocates it on its heap. */
const PULL_CHUNK_BYTES = 1024;
/** Captures are text; recorded RAW Sub-GHz files reach a few MiB. */
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const REMEDIATION =
  "Install REA with its optional serialport dependency on a platform that has a prebuilt binding.";

export interface FlipperProviderOptions {
  /** Host serial access; defaults to the lazily loaded `serialport` binding. */
  readonly serialAccess?: () => Promise<FlipperSerialAccess>;
}

/**
 * Flipper Zero inspection through its USB serial CLI. REA only opens ports
 * the host enumerates with the Flipper USB identity and only sends fixed
 * read-only commands: `device_info`, `storage list`, `storage read_chunks`,
 * and `storage md5`. It never writes device storage or drives a radio.
 */
export class FlipperProvider {
  readonly #serialAccess: () => Promise<FlipperSerialAccess>;
  readonly #activeOperations = new Set<Promise<unknown>>();
  #closing = false;

  constructor(options: FlipperProviderOptions = {}) {
    this.#serialAccess = options.serialAccess ?? loadSerialportAccess;
  }

  /** Load the serial binding without opening any port. */
  async inspectAvailability(): Promise<ProviderAvailability> {
    try {
      await this.#serialAccess();
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: {},
      };
    } catch (cause) {
      return {
        status: "unavailable",
        code: "runtime_unavailable",
        reason: `The serialport binding could not be loaded: ${describe(cause)}. ${REMEDIATION}`,
        diagnostics: {},
      };
    }
  }

  /** Stop admission and wait for in-flight exchanges to release their ports. */
  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled(this.#activeOperations);
  }

  async execute(
    request: FlipperRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing || options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(request.operation));
    const active = this.#executeOperation(request, options?.signal);
    this.#activeOperations.add(active);
    try {
      return await active;
    } finally {
      this.#activeOperations.delete(active);
    }
  }

  async #executeOperation(
    request: FlipperRequest,
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const operation = request.operation;
    if (request.operation === "inspect_flipper_capture")
      return inspectCapture(request.operation, request.input.path);
    let access: FlipperSerialAccess;
    try {
      access = await this.#serialAccess();
    } catch (cause) {
      return err(
        new AnalysisCapabilityUnavailableError(
          FLIPPER_PROVIDER_IDENTITY.id,
          operation,
          `the serialport binding could not be loaded: ${describe(cause)}`,
          { cause, remediationAction: REMEDIATION },
        ),
      );
    }
    let devices: FlipperDevice[];
    try {
      devices = await listFlipperDevices(access);
    } catch (cause) {
      return err(
        new AnalysisProtocolError(
          `Serial port enumeration failed: ${describe(cause)}`,
          { cause },
        ),
      );
    }
    if (request.operation === "list_flipper_devices")
      return ok(
        createAnalysisExecution({ devices }, FLIPPER_PROVIDER_IDENTITY, {
          limitations: [
            "Only ports enumerated with the Flipper USB identity 0483:5740 are listed; Bluetooth serial links are not",
          ],
        }),
      );
    const port = request.input.port;
    if (!devices.some((device) => device.port === port))
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          port,
          "the host does not enumerate this port with the Flipper USB identity; use a port from list_flipper_devices",
        ),
      );
    const timeoutMs =
      operation === "pull_flipper_file" ? PULL_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
    let session: FlipperCliSession;
    try {
      session = await FlipperCliSession.open(
        access.openLink,
        port,
        timeoutMs,
        signal,
      );
    } catch (cause) {
      return err(
        cause instanceof FlipperTransportFailure
          ? transportError(operation, port, cause)
          : new AnalysisUnsupportedTargetError(
              operation,
              port,
              `the port could not be opened (${describe(cause)}); close qFlipper or other apps holding it`,
              { cause },
            ),
      );
    }
    try {
      return await runOnSession(request, port, session);
    } catch (cause) {
      if (cause instanceof FlipperTransportFailure)
        return err(transportError(operation, port, cause));
      throw cause;
    } finally {
      await session.close();
    }
  }
}

/** Decode one local capture file; never contacts a device. */
const inspectCapture = async (
  operation: "inspect_flipper_capture",
  path: string,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const localPath = absoluteCallerPath(path);
  let bytes: Buffer;
  try {
    const info = await stat(localPath);
    if (!info.isFile() || info.size > MAX_CAPTURE_BYTES)
      return err(
        new AnalysisUnsupportedTargetError(
          operation,
          localPath,
          info.isFile()
            ? `capture files are limited to ${String(MAX_CAPTURE_BYTES)} bytes`
            : "not a regular file",
        ),
      );
    bytes = await readFile(localPath);
  } catch (cause) {
    return err(
      new AnalysisUnsupportedTargetError(
        operation,
        localPath,
        `the file could not be read (${describe(cause)})`,
        { cause },
      ),
    );
  }
  return ok(
    createAnalysisExecution(
      {
        local_path: localPath,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...decodeFlipperCapture(bytes.toString("utf8")),
      },
      FLIPPER_PROVIDER_IDENTITY,
      {
        limitations: [
          "Stored values are reported as written; numeric values, modulation labels, NDEF records, and EM4100 fields are derived",
        ],
      },
    ),
  );
};

/** Compose and run the fixed read-only CLI commands for one port request. */
const runOnSession = async (
  request: Exclude<
    FlipperRequest,
    { operation: "list_flipper_devices" | "inspect_flipper_capture" }
  >,
  port: string,
  session: FlipperCliSession,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  switch (request.operation) {
    case "inspect_flipper_device": {
      const properties = parsed(
        parseFlipperDeviceInfo(await session.run("device_info")),
        "device_info",
      );
      if (!properties.ok) return properties;
      return ok(
        createAnalysisExecution(
          { port, properties: properties.value },
          FLIPPER_PROVIDER_IDENTITY,
        ),
      );
    }
    case "list_flipper_directory": {
      const path = request.input.device_path;
      const text = await session.run(`storage list "${path}"`);
      const refusal = flipperStorageError(text);
      if (refusal !== undefined)
        return err(storageRefusal(request.operation, path, refusal));
      const entries = parsed(parseFlipperStorageList(text), "storage list");
      if (!entries.ok) return entries;
      return ok(
        createAnalysisExecution(
          { port, device_path: path, entries: entries.value },
          FLIPPER_PROVIDER_IDENTITY,
        ),
      );
    }
    case "pull_flipper_file":
      return pullFile(request.operation, port, request.input, session);
  }
};

const listFlipperDevices = async (
  access: FlipperSerialAccess,
): Promise<FlipperDevice[]> =>
  (await access.listPorts())
    .filter(
      (port) =>
        port.vendorId === FLIPPER_USB_VENDOR_ID &&
        port.productId === FLIPPER_USB_PRODUCT_ID,
    )
    .map((port) => ({
      port: port.path,
      serial_number: port.serialNumber,
      manufacturer: port.manufacturer,
    }));

/** Create the caller's output file exclusively; an existing file is never replaced. */
const createPullTarget = async (
  operation: "pull_flipper_file",
  input: { readonly device_path: string; readonly output_directory: string },
): Promise<Result<{ localPath: string; file: FileHandle }, AnalysisError>> => {
  const derived = adbHostFileName(input.device_path);
  if (!derived.ok)
    return err(
      new AnalysisInputError(operation, undefined, [
        {
          path: ["device_path"],
          reason: "invalid_value",
          message: `The device path ${JSON.stringify(input.device_path)} does not name a file that can be written on this host (${derived.reason}); REA never renames a device-reported file.`,
        },
      ]),
    );
  const directory = absoluteCallerPath(input.output_directory);
  try {
    await mkdir(directory, { recursive: true });
    await access(directory, fsConstants.W_OK);
  } catch (cause) {
    return err(
      new AnalysisOutputError(
        operation,
        `The output directory is not writable or could not be created: ${directory}`,
        { cause },
      ),
    );
  }
  const localPath = appendCallerPath(directory, derived.fileName);
  try {
    return ok({ localPath, file: await open(localPath, "wx") });
  } catch (cause) {
    return err(
      new AnalysisOutputError(
        operation,
        `The output file already exists or cannot be created: ${localPath}`,
        { cause },
      ),
    );
  }
};

const pullFile = async (
  operation: "pull_flipper_file",
  port: string,
  input: { readonly device_path: string; readonly output_directory: string },
  session: FlipperCliSession,
): Promise<Result<AnalysisExecution, AnalysisError>> => {
  const target = await createPullTarget(operation, input);
  if (!target.ok) return target;
  const { localPath, file } = target.value;
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  let complete = false;
  try {
    const read = await session.readChunks(
      input.device_path,
      PULL_CHUNK_BYTES,
      async (chunk) => {
        sha256.update(chunk);
        md5.update(chunk);
        await file.write(chunk);
      },
    );
    if ("refusal" in read)
      return err(
        storageRefusal(
          operation,
          input.device_path,
          flipperStorageError(read.refusal) ?? read.refusal.trim(),
        ),
      );
    await file.close();
    const deviceMd5 = parsed(
      parseFlipperMd5(await session.run(`storage md5 "${input.device_path}"`)),
      "storage md5",
    );
    if (!deviceMd5.ok) return deviceMd5;
    const localMd5 = md5.digest("hex");
    if (deviceMd5.value !== localMd5)
      return err(
        new AnalysisProtocolError(
          `The pulled copy's MD5 ${localMd5} does not match the device's ${deviceMd5.value}; the partial copy was removed`,
        ),
      );
    complete = true;
    return ok(
      createAnalysisExecution(
        {
          port,
          device_path: input.device_path,
          local_path: localPath,
          bytes: read.bytes,
          sha256: sha256.digest("hex"),
          device_md5: deviceMd5.value,
        },
        FLIPPER_PROVIDER_IDENTITY,
        {
          limitations: [
            "The pulled file is a host-local copy; the Flipper retains the original",
          ],
        },
      ),
    );
  } finally {
    await file.close().catch(() => undefined);
    if (!complete) await rm(localPath, { force: true });
  }
};

const parsed = <T>(
  result: FlipperParse<T>,
  command: string,
): Result<T, AnalysisError> =>
  result.ok
    ? ok(result.value)
    : err(
        new AnalysisProtocolError(
          `Unrecognized \`${command}\` output line: ${JSON.stringify(result.line)}`,
        ),
      );

const storageRefusal = (
  operation: FlipperOperation,
  path: string,
  reason: string,
): AnalysisError =>
  new AnalysisUnsupportedTargetError(
    operation,
    path,
    `Flipper storage refused the path: ${reason}`,
  );

const transportError = (
  operation: FlipperOperation,
  port: string,
  failure: FlipperTransportFailure,
): AnalysisError => {
  switch (failure.kind) {
    case "cancelled":
      return new AnalysisCancelledError(operation, { cause: failure });
    case "timeout":
      return new AnalysisTimeoutError(operation, failure.timeoutMs ?? 0, {
        cause: failure,
        userMessage:
          "The Flipper CLI did not answer in time; it may be busy in an app that holds the CLI.",
        remediationAction:
          "Return the Flipper to its desktop screen and retry.",
      });
    case "closed":
      return new AnalysisUnsupportedTargetError(
        operation,
        port,
        "the serial port closed during the exchange; the Flipper may have been unplugged",
        { cause: failure },
      );
    case "protocol":
      return new AnalysisProtocolError(failure.message, { cause: failure });
  }
};

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
