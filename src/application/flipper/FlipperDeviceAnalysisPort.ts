import type {
  AnalysisExecution,
  ExecutionOptions,
  ProviderAvailability,
} from "../AnalysisProvider.js";
import type { FlipperRequest } from "../../domain/flipper/flipperDeviceAnalysis.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/**
 * Flipper Zero inspection boundary over the host's USB serial ports.
 * Implementation details belong to the provider adapter.
 */
export interface FlipperDeviceAnalysisPort {
  /** Load the serial binding without opening a port. */
  inspectAvailability(signal?: AbortSignal): Promise<ProviderAvailability>;
  /** Stop admission and wait for open ports to be released. */
  close(): Promise<void>;
  execute(
    request: FlipperRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}
