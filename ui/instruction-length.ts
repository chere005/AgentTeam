/**
 * Soft guidance for the agent panel's always-loaded instructions: they travel with every run, so
 * short role instructions (responsibilities and output contract) cost less than long manuals;
 * detailed reference belongs in an on-demand skill. Never a block, only a visible hint.
 */
export const INSTRUCTION_SOFT_LIMIT = 1500;

export type InstructionLengthHint = {
  chars: number;
  /** Same approximation as the run context record: characters / 4. */
  approxTokens: number;
  level: "none" | "ok" | "long";
  message: string;
};

export function instructionLengthHint(text: string): InstructionLengthHint {
  const chars = text.trim().length;
  const approxTokens = Math.ceil(chars / 4);
  if (!chars)
    return {
      chars,
      approxTokens,
      level: "none",
      message:
        "Short, focused role instructions work best: responsibilities and the expected output. Put detailed reference in an on-demand skill.",
    };
  if (chars > INSTRUCTION_SOFT_LIMIT)
    return {
      chars,
      approxTokens,
      level: "long",
      message: `Long: about ${approxTokens.toLocaleString()} tokens are sent with every run. Consider keeping only responsibilities and the output contract here and moving reference material into an on-demand skill. You can still save it as is.`,
    };
  return {
    chars,
    approxTokens,
    level: "ok",
    message: `About ${approxTokens.toLocaleString()} tokens are sent with every run.`,
  };
}

/** Points for a tiny inline sparkline: x spread over `width`, y inverted into `height`. */
export function sparklinePoints(
  values: number[],
  width: number,
  height: number,
): string {
  if (!values.length) return "";
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map(
      (v, i) =>
        `${(values.length > 1 ? i * step : width / 2).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`,
    )
    .join(" ");
}
