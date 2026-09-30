import type { TeslemetryApiError } from "../@types/error.js";

function textBodyMessage(body: string): string {
  const text = body.trim();
  if (!text.startsWith("<")) return text.slice(0, 200);
  return /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1].trim() ?? "";
}

/**
 * The SDK's generated client rejects with the parsed JSON error body
 * (`{error, error_description}`), the raw response text when the body isn't
 * JSON (a Cloudflare/Caddy HTML error page), or `{}` for an empty body,
 * rather than an Error, so `.message` is undefined and a template string
 * logs "[object Object]". Normalizes any rejection into an Error carrying
 * the server's error `code`, whose message is never empty: the translated
 * `error.<code>` text when one exists, else `error_description`, then the
 * code, then the text body (an HTML page's `<title>`, which names the HTTP
 * status - the thrown body carries none of its own), then the translated
 * `error.request_failed`.
 */
export default function toError(
  rejection: unknown,
  translate: (key: string) => string,
): Error & { code?: string } {
  const fallback = () => {
    const translation = translate("error.request_failed");
    return translation && translation !== "error.request_failed"
      ? translation
      : "Teslemetry request failed";
  };
  if (rejection instanceof Error) {
    return rejection.message.trim() ? rejection : new Error(fallback());
  }
  if (typeof rejection === "string") {
    return new Error(textBodyMessage(rejection) || fallback());
  }
  const { error, error_description } = (rejection ?? {}) as Partial<TeslemetryApiError>;
  const code =
    typeof error === "string" && error.trim() ? error.trim().toLowerCase() : undefined;
  const key = `error.${code}`;
  const translation = code ? translate(key) : undefined;
  const description =
    typeof error_description === "string" ? error_description.trim() : "";
  const message =
    translation && translation !== key
      ? translation
      : description || code || fallback();
  return code ? Object.assign(new Error(message), { code }) : new Error(message);
}
