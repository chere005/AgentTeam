export const FILE_EDITOR_LEAVE_EVENT = "agentteam:before-file-editor-leave";

/** Ask the mounted editor whether a view, folder or project change may discard its draft. */
export function canLeaveFileEditor(): boolean {
  const event = new Event(FILE_EDITOR_LEAVE_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  return !event.defaultPrevented;
}
