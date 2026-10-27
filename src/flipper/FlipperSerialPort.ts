import type { OpenFlipperLink } from "./FlipperCliSession.js";

/** Host serial port facts as the operating system enumerates them. */
export interface HostSerialPort {
  readonly path: string;
  readonly vendorId: string | null;
  readonly productId: string | null;
  readonly serialNumber: string | null;
  readonly manufacturer: string | null;
}

/** Host serial access; tests substitute an enumerated port list and a scripted link. */
export interface FlipperSerialAccess {
  readonly listPorts: () => Promise<readonly HostSerialPort[]>;
  readonly openLink: OpenFlipperLink;
}

/** Baud rate is ignored by USB CDC; the value matches the firmware's UART CLI. */
const BAUD_RATE = 230_400;

const nullable = (value: string | undefined): string | null =>
  value === undefined || value === "" ? null : value;

/**
 * Load the `serialport` native binding on first use, so a host without a
 * prebuilt binding reports the Flipper family unavailable instead of failing
 * server startup.
 */
export const loadSerialportAccess = async (): Promise<FlipperSerialAccess> => {
  const { SerialPort } = await import("serialport");
  return {
    listPorts: async () =>
      (await SerialPort.list()).map((port) => ({
        path: port.path,
        vendorId: nullable(port.vendorId?.toLowerCase()),
        productId: nullable(port.productId?.toLowerCase()),
        serialNumber: nullable(port.serialNumber),
        manufacturer: nullable(port.manufacturer),
      })),
    openLink: (path, onData, onClose) =>
      new Promise((resolve, reject) => {
        const port = new SerialPort({
          path,
          baudRate: BAUD_RATE,
          autoOpen: false,
        });
        port.open((cause) => {
          if (cause) {
            reject(cause);
            return;
          }
          port.on("data", (bytes: Buffer) => onData(bytes));
          port.on("close", onClose);
          port.on("error", onClose);
          resolve({
            write: (bytes) => {
              port.write(Buffer.from(bytes));
            },
            close: () =>
              new Promise<void>((done) => {
                if (!port.isOpen) {
                  done();
                  return;
                }
                port.close(() => done());
              }),
          });
        });
      }),
  };
};
