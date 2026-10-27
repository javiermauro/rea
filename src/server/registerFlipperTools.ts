import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { FlipperDeviceAnalysisService } from "../application/flipper/FlipperDeviceAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createContractToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";

/** Bind Flipper handlers to their exact named contracts through shared workflows. */
export const registerFlipperTools = (
  server: EvidenceMcpServer,
  service: FlipperDeviceAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const handler = createContractToolHandler(
    server,
    service,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  for (const contract of [
    toolContract("list_flipper_devices"),
    toolContract("inspect_flipper_device"),
    toolContract("list_flipper_directory"),
    toolContract("pull_flipper_file"),
    toolContract("inspect_flipper_capture"),
  ] as const) {
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      handler(contract),
    );
  }
};
