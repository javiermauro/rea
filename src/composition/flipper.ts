import type { FlipperDeviceAnalysisPort } from "../application/flipper/FlipperDeviceAnalysisPort.js";
import { FlipperProvider } from "../flipper/FlipperProvider.js";

/** Construct one Flipper provider over the host's serial ports. */
export const createFlipperDeviceAnalysisProvider =
  (): FlipperDeviceAnalysisPort => new FlipperProvider();
