import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { z } from "incur";
import { FlipperDeviceAnalysisService } from "../application/flipper/FlipperDeviceAnalysisService.js";
import type { FlipperDeviceAnalysisPort } from "../application/flipper/FlipperDeviceAnalysisPort.js";
import { createFlipperDeviceAnalysisProvider } from "../composition/flipper.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { FlipperOperation } from "../domain/flipper/flipperDeviceAnalysis.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Expose the same explicit Flipper requests through one-shot CLI commands. */
export const registerFlipperCommands = (
  cli: CliInstance,
  logger: Logger,
  provider: FlipperDeviceAnalysisPort = createFlipperDeviceAnalysisProvider(),
): void => {
  const service = new FlipperDeviceAnalysisService(provider);
  const execute = (name: string, operation: FlipperOperation, input: unknown) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, () =>
        finishAnalysisCommand(
          () => service.execute(operation, input, { signal }),
          { close: () => provider.close() },
          "flipper",
          operation,
          signal,
        ).then(projectCliAnalysisResult),
      ),
    );

  const port = z
    .string()
    .min(1)
    .describe("Serial port exactly as `list-flipper-devices` reports it");
  const devicePath = z
    .string()
    .min(1)
    .describe("Absolute Flipper path under /ext or /int");

  cli.command(CLI_COMMANDS.listFlipperDevices, {
    description: "List Flipper Zero devices attached over USB serial",
    args: z.object({}),
    run: () =>
      execute(CLI_COMMANDS.listFlipperDevices, "list_flipper_devices", {}),
  });
  cli.command(CLI_COMMANDS.inspectFlipperDevice, {
    description: "Inspect one Flipper's hardware and firmware identity",
    args: z.object({ port }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectFlipperDevice, "inspect_flipper_device", {
        port: args.port,
      }),
  });
  cli.command(CLI_COMMANDS.listFlipperDirectory, {
    description: "List one Flipper storage directory",
    args: z.object({ port, "device-path": devicePath }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.listFlipperDirectory, "list_flipper_directory", {
        port: args.port,
        device_path: args["device-path"],
      }),
  });
  cli.command(CLI_COMMANDS.pullFlipperFile, {
    description:
      "Copy one Flipper file to a new local file verified by the device MD5",
    args: z.object({ port, "device-path": devicePath }),
    options: z.object({
      "output-directory": z
        .string()
        .min(1)
        .describe("Local directory for the pulled file"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.pullFlipperFile, "pull_flipper_file", {
        port: args.port,
        device_path: args["device-path"],
        output_directory: options["output-directory"],
      }),
  });
  cli.command(CLI_COMMANDS.inspectFlipperCapture, {
    description:
      "Decode a local Flipper capture file (.sub, .ir, .nfc, .rfid, .ibtn)",
    args: z.object({
      path: z.string().min(1).describe("Local capture file path"),
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectFlipperCapture, "inspect_flipper_capture", {
        path: args.path,
      }),
  });
};
