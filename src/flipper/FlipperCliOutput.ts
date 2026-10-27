import type { FlipperDirectoryEntry } from "../domain/flipper/flipperDeviceAnalysis.js";

/** Parsed CLI text, or the line that did not match the expected grammar. */
export type FlipperParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly line: string };

const lines = (text: string): string[] =>
  text.split(/\r?\n/u).filter((line) => line.trim() !== "");

/** `Storage error: file/dir not exist` and friends, when the CLI refused. */
export const flipperStorageError = (text: string): string | undefined =>
  /^Storage error: (.+)$/mu.exec(text)?.[1]?.trim();

/** `device_info` prints `%-30s: %s`; values are kept exactly as printed. */
export const parseFlipperDeviceInfo = (
  text: string,
): FlipperParse<{ key: string; value: string }[]> => {
  const properties: { key: string; value: string }[] = [];
  for (const line of lines(text)) {
    const match = /^([a-z0-9_]+)\s*: ?(.*)$/u.exec(line);
    if (match === null) return { ok: false, line };
    properties.push({ key: match[1]!, value: match[2]!.trimEnd() });
  }
  return { ok: true, value: properties };
};

/** `storage list` prints `\t[D] name` and `\t[F] name <size>b` per entry. */
export const parseFlipperStorageList = (
  text: string,
): FlipperParse<FlipperDirectoryEntry[]> => {
  const entries: FlipperDirectoryEntry[] = [];
  for (const line of lines(text)) {
    if (line.trim() === "Empty") continue;
    const directory = /^\t\[D\] (.+)$/u.exec(line);
    if (directory !== null) {
      entries.push({ name: directory[1]!, kind: "directory", bytes: null });
      continue;
    }
    const file = /^\t\[F\] (.+) (\d+)b$/u.exec(line);
    if (file === null) return { ok: false, line };
    entries.push({ name: file[1]!, kind: "file", bytes: Number(file[2]) });
  }
  return { ok: true, value: entries };
};

/** `storage md5` prints one lowercase hex digest line. */
export const parseFlipperMd5 = (text: string): FlipperParse<string> => {
  const [line = "", ...rest] = lines(text);
  return /^[a-f0-9]{32}$/u.test(line.trim()) && rest.length === 0
    ? { ok: true, value: line.trim() }
    : { ok: false, line };
};
