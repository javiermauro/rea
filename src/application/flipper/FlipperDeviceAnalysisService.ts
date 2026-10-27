import type { FlipperDeviceAnalysisPort } from "./FlipperDeviceAnalysisPort.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import {
  flipperRequestSchema,
  type FlipperOperation,
} from "../../domain/flipper/flipperDeviceAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import type { Result } from "../../domain/result.js";
import { executeProviderOperation } from "../ProviderOperationExecution.js";

/** Shared CLI/MCP admission, execution, and Evidence composition for Flipper. */
export class FlipperDeviceAnalysisService {
  constructor(readonly provider: FlipperDeviceAnalysisPort) {}

  /** Run one caller-selected Flipper request and retain device provenance inline. */
  async execute(
    operation: FlipperOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeProviderOperation(
      operation,
      input,
      options,
      flipperRequestSchema,
      this.provider,
      "observed",
    );
  }
}
