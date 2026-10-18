import { AppError } from "./model.ts";

export const providerErrorKinds = [
  "authentication",
  "quota",
  "model-unavailable",
  "process-failure",
  "timeout",
  "cancellation",
] as const;
export type ProviderErrorKind = (typeof providerErrorKinds)[number];

export type FailureInput = {
  message?: string;
  code?: string;
  status?: number;
  cancelled?: boolean;
};

const authPattern =
  /\b(unauthori[sz]ed|unauthenticated|not (logged|signed) in|log ?in required|please (log ?in|sign ?in|run .*login)|invalid[ _-]?(api[ _-]?key|token|credentials)|authentication[ _-]?(failed|error|required)|expired (token|session|credentials)|401|403 forbidden|permission_denied)\b/i;
const quotaPattern =
  /\b(rate[ _-]?limit(ed)?|too many requests|quota|usage limit|limit reached|credit balance|insufficient[ _-]?(credits?|funds|quota)|billing|429|overloaded|resource[ _-]?exhausted|exceeded your)\b/i;
const modelPattern =
  /\b(model[^.\n]{0,60}(not found|unavailable|not available|does not exist|unsupported|not supported|deprecated|no access)|(unknown|invalid|unsupported|unavailable) model|no such model|model_not_found|do(es)? not have access to (the )?model)\b/i;

/** Pure classification of a provider failure into a stable kind. */
export function classifyProviderFailure(
  input: FailureInput,
): ProviderErrorKind {
  if (input.cancelled || input.code === "cancelled" || input.status === 499)
    return "cancellation";
  if (
    input.code === "runtime_timeout" ||
    input.code === "provider_timeout" ||
    input.status === 504
  )
    return "timeout";
  const text = input.message ?? "";
  if (modelPattern.test(text)) return "model-unavailable";
  if (authPattern.test(text)) return "authentication";
  if (quotaPattern.test(text)) return "quota";
  if (/\btimed? ?out\b/i.test(text) && /provider|request|limit/i.test(text))
    return "timeout";
  return "process-failure";
}

export class ProviderError extends AppError {
  kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind, original: AppError | Error) {
    const status =
      original instanceof AppError
        ? original.status
        : kind === "cancellation"
          ? 499
          : 502;
    const message = original.message.startsWith(`[${kind}] `)
      ? original.message
      : `[${kind}] ${original.message}`;
    super(
      status,
      original instanceof AppError
        ? original.code
        : `provider_${kind.replaceAll("-", "_")}`,
      message,
    );
    this.kind = kind;
  }
}

/** Wrap any thrown value as a ProviderError carrying its classified kind. */
export function toProviderError(
  error: unknown,
  options: { cancelled?: boolean } = {},
): ProviderError {
  if (error instanceof ProviderError) return error;
  const original =
    error instanceof Error
      ? error
      : new Error(String(error ?? "Runtime failed"));
  const kind = classifyProviderFailure({
    message: original.message,
    code: original instanceof AppError ? original.code : undefined,
    status: original instanceof AppError ? original.status : undefined,
    cancelled: options.cancelled,
  });
  return new ProviderError(kind, original);
}

export function errorKindOf(error: unknown): ProviderErrorKind | undefined {
  return error instanceof ProviderError ? error.kind : undefined;
}
