/** Byte link to one opened serial port; tests substitute a scripted device. */
export interface FlipperLink {
  write(bytes: Uint8Array): void;
  close(): Promise<void>;
}

/** Opens a link and delivers every received byte to `onData`. */
export type OpenFlipperLink = (
  port: string,
  onData: (bytes: Uint8Array) => void,
  onClose: () => void,
) => Promise<FlipperLink>;

/** Why a CLI exchange did not complete. */
export class FlipperTransportFailure extends Error {
  constructor(
    readonly kind: "timeout" | "closed" | "cancelled" | "protocol",
    message: string,
    readonly timeoutMs?: number,
  ) {
    super(message);
  }
}

const PROMPT = Buffer.from("\r\n>: ", "latin1");
const READY = Buffer.from("\r\nReady?\r\n", "latin1");
const encoder = new TextEncoder();
// ponytail: fixed settle delay after the banner; replace with a sentinel
// command exchange if a firmware ever answers slower than this.
const QUIET_MS = 250;

type Waiter = {
  readonly take: (buffer: Buffer) => number | undefined;
  readonly resolve: (bytes: Buffer) => void;
  readonly reject: (failure: FlipperTransportFailure) => void;
};

/**
 * One interactive Flipper CLI session. Every exchange waits for the `>: `
 * prompt, so commands never overlap and the device is idle when the session
 * closes. Only the fixed commands the provider composes are written.
 */
export class FlipperCliSession {
  #buffer = Buffer.alloc(0);
  #waiter: Waiter | undefined;
  #closed = false;

  private constructor(
    private link: FlipperLink | undefined,
    private readonly deadline: number,
    private readonly timeoutMs: number,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /** Open the port and wait for the banner prompt within one operation deadline. */
  static async open(
    openLink: OpenFlipperLink,
    port: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<FlipperCliSession> {
    const session = new FlipperCliSession(
      undefined,
      Date.now() + timeoutMs,
      timeoutMs,
      signal,
    );
    session.link = await openLink(
      port,
      (bytes) => session.#receive(bytes),
      () =>
        session.#fail(
          new FlipperTransportFailure("closed", "The serial port closed"),
        ),
    );
    try {
      // A fresh CLI session prints its banner; a reused one is already idle.
      // The extra prompt that follows a banner arrives late, so let the line
      // go quiet and discard everything before the first command.
      session.#send("\r");
      await session.#untilPrompt();
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    } catch (cause) {
      await session.close();
      throw cause;
    }
    session.#buffer = Buffer.alloc(0);
    return session;
  }

  /** Run one text command; returns output between its echo and the prompt. */
  async run(command: string): Promise<string> {
    this.#send(`${command}\r`);
    const reply = await this.#untilPrompt();
    const echoEnd = reply.indexOf("\r\n");
    return echoEnd < 0 || echoEnd + 2 > reply.length - PROMPT.length
      ? ""
      : reply
          .subarray(echoEnd + 2, reply.length - PROMPT.length)
          .toString("utf8");
  }

  /**
   * `storage read_chunks`: after `Size: N`, each `Ready?` is acknowledged
   * with one byte and answered with exactly the next block of raw bytes.
   * Returns the CLI text instead when the device refused before `Size:`.
   */
  async readChunks(
    path: string,
    chunkBytes: number,
    sink: (chunk: Buffer) => Promise<void>,
  ): Promise<{ readonly bytes: number } | { readonly refusal: string }> {
    this.#send(`storage read_chunks "${path}" ${String(chunkBytes)}\r`);
    const header = (
      await this.#wait((buffer) => {
        const size = /Size: (\d+)\r\n/u.exec(buffer.toString("latin1"));
        if (size !== null) return size.index + size[0].length;
        const prompt = buffer.indexOf(PROMPT);
        return prompt < 0 ? undefined : prompt + PROMPT.length;
      })
    ).toString("utf8");
    const size = /Size: (\d+)/u.exec(header);
    if (size === null) return { refusal: header };
    const total = Number(size[1]);
    let remaining = total;
    while (remaining > 0) {
      await this.#wait((buffer) => {
        const ready = buffer.indexOf(READY);
        return ready < 0 ? undefined : ready + READY.length;
      });
      this.#send("y");
      const length = Math.min(chunkBytes, remaining);
      await sink(
        await this.#wait((buffer) =>
          buffer.length >= length ? length : undefined,
        ),
      );
      remaining -= length;
    }
    await this.#untilPrompt();
    return { bytes: total };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.link?.close();
  }

  #untilPrompt(): Promise<Buffer> {
    return this.#wait((buffer) => {
      const prompt = buffer.indexOf(PROMPT);
      return prompt < 0 ? undefined : prompt + PROMPT.length;
    });
  }

  #send(text: string): void {
    if (this.#closed)
      throw new FlipperTransportFailure("closed", "The session is closed");
    this.link!.write(encoder.encode(text));
  }

  #receive(bytes: Uint8Array): void {
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    this.#settle();
  }

  #settle(): void {
    const waiter = this.#waiter;
    if (waiter === undefined) return;
    const end = waiter.take(this.#buffer);
    if (end === undefined) return;
    const taken = this.#buffer.subarray(0, end);
    this.#buffer = this.#buffer.subarray(end);
    this.#waiter = undefined;
    waiter.resolve(Buffer.from(taken));
  }

  #fail(failure: FlipperTransportFailure): void {
    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.reject(failure);
  }

  #wait(take: Waiter["take"]): Promise<Buffer> {
    if (this.signal?.aborted === true)
      return Promise.reject(
        new FlipperTransportFailure("cancelled", "The operation was cancelled"),
      );
    if (this.#closed)
      return Promise.reject(
        new FlipperTransportFailure("closed", "The serial port closed"),
      );
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.#fail(
            new FlipperTransportFailure(
              "timeout",
              "The Flipper CLI did not answer before the deadline",
              this.timeoutMs,
            ),
          ),
        Math.max(0, this.deadline - Date.now()),
      );
      const onAbort = () =>
        this.#fail(
          new FlipperTransportFailure(
            "cancelled",
            "The operation was cancelled",
          ),
        );
      this.signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
      };
      this.#waiter = {
        take,
        resolve: (bytes) => {
          done();
          resolve(bytes);
        },
        reject: (failure) => {
          done();
          reject(failure);
        },
      };
      this.#settle();
    });
  }
}
