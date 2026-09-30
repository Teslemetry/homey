import type { TeslemetryApiError } from "../@types/error.js";

/**
 * The SDK's generated client rejects with the parsed JSON error body
 * (`{error, error_description}`) or the raw response text rather than an
 * Error, so `.message` is undefined and a template string logs "[object
 * Object]". Normalizes any rejection into an Error carrying the server's
 * error `code`, with the translated `error.<code>` text as its message when
 * one exists, else the server's own description.
 */
export default function toError(
  rejection: unknown,
  translate: (key: string) => string,
): Error & { code?: string } {
  if (rejection instanceof Error) return rejection;
  if (typeof rejection === "string" && rejection !== "") return new Error(rejection);
  const { error, error_description } = (rejection ?? {}) as Partial<TeslemetryApiError>;
  const code = typeof error === "string" ? error.toLowerCase() : undefined;
  const key = `error.${code}`;
  const translation = code ? translate(key) : undefined;
  const message =
    translation && translation !== key
      ? translation
      : error_description || code || "Teslemetry request failed";
  return code ? Object.assign(new Error(message), { code }) : new Error(message);
}
