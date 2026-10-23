import type { Task } from "./model.ts";

/** True when an agent explicitly says it could not do the task and reports no work performed. */
export function explicitlyReportsNoWork(value: string | null | undefined) {
  if (!value) return false;
  const unableToComplete =
    /\b(?:i|we)\s+(?:couldn't|could not|can't|cannot|am unable to|are unable to|was unable to|were unable to)\s+(?:do|complete|perform|execute|carry out)\s+(?:(?:this|the)\s+)?(?:task|request|work)\b/i.test(
      value,
    );
  const noToolsToAct =
    /\b(?:i|we)\s+(?:have|had) no (?:way|tools?) to\s+(?:write|create|run|build|execute)\b/i.test(
      value,
    );
  const nothingDone =
    /\b(?:nothing|no files?)\s+(?:was|were|has been|have been)\s+(?:created|written|modified|changed|built|run|executed)\b/i.test(
      value,
    );
  return unableToComplete && (noToolsToAct || nothingDone);
}

/**
 * A task that requires execution must not be marked complete when the agent explicitly says it
 * did not execute the deliverable. This catches provider responses that wrote source but skipped
 * the requested build/run while leaving ordinary implementation tasks unaffected.
 */
export function explicitlyReportsIncompleteExecution(
  task: Pick<Task, "title" | "instructions" | "completionCriteria">,
  value: string | null | undefined,
) {
  if (!value) return false;
  const request = `${task.title}\n${task.instructions}\n${task.completionCriteria}`;
  const coordinationOnly =
    /\b(?:plan|coordinate|delegate)\b/i.test(task.title) &&
    !/\b(?:run|execute|build|compile|typecheck|test)\b/i.test(task.title);
  const requiresExecution =
    !coordinationOnly &&
    /\b(?:run|execute|build|compile|typecheck|test)\b/i.test(request);
  if (!requiresExecution) return false;
  const reportsSuccessfulExecution =
    /\b(?:exit(?:ed)?\s+(?:with\s+)?(?:status|code))\s*(?:is\s*)?[:=]?\s*0\b/i.test(
      value,
    ) && /\b(?:stdout|output)\b/i.test(value);
  if (reportsSuccessfulExecution) return false;
  const executionVerb = String.raw`(?:r(?:un|an)|execut(?:e|ed|ing)|build(?:|ing|t)|compil(?:e|ed|ing)|typecheck(?:ed|ing)?|test(?:ed|ing)?)`;
  return (
    new RegExp(
      String.raw`\b(?:haven't|have not|didn't|did not|couldn't|could not|can't|cannot|not yet)\s+(?:(?:actually|successfully)\s+)?${executionVerb}(?:\s+(?:it|the|this|anything|program|command))?\b`,
      "i",
    ).test(value) ||
    new RegExp(
      String.raw`\b(?:command|program|build|test)\s+(?:was\s+)?not\s+(?:actually\s+)?${executionVerb}\b`,
      "i",
    ).test(value) ||
    /\bnothing\s+(?:hasn't|has not|wasn't|was not|isn't|is not)?\s*(?:been\s+)?(?:built|compiled|run|executed|tested)\b|\b(?:still\s+)?(?:queued|waiting)\b.{0,100}\b(?:not started|haven't started|have not started|didn't start|did not start)\b/i.test(
      value,
    ) ||
    /\b(?:bash|shell)\s+(?:tool|access)?\s*(?:is\s+)?(?:disabled|unavailable)\b/i.test(
      value,
    )
  );
}

/** A requested approval review is not complete when the reviewer explicitly withholds approval. */
export function explicitlyReportsUnapprovedReview(
  task: Pick<Task, "title" | "instructions" | "completionCriteria">,
  value: string | null | undefined,
) {
  if (!value) return false;
  const request = `${task.title}\n${task.instructions}\n${task.completionCriteria}`;
  if (!/\b(?:approve|approval|approved|sign.off)\b/i.test(request))
    return false;
  return /\bverdict\s*[:—-]\s*(?:inconclusive|needs? changes|rejected|not approved)\b|\bapproval\s+(?:is\s+)?(?:blocked|withheld)\b/i.test(
    value,
  );
}

/** Short evidence-based reason a task must not count as successfully completed. */
export function taskCompletionProblem(
  task: Pick<Task, "title" | "instructions" | "completionCriteria"> & {
    result?: string | null;
  },
) {
  if (explicitlyReportsNoWork(task.result)) return "didn’t complete";
  if (explicitlyReportsIncompleteExecution(task, task.result))
    return "didn’t run";
  if (explicitlyReportsUnapprovedReview(task, task.result))
    return "review inconclusive";
  return null;
}
