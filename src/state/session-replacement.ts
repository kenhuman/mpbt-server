import type { ClientSession } from './players.js';
import { worldResumeRegistry } from './world-resume.js';

function shouldPreserveWorldResume(session: ClientSession): boolean {
  return (
    session.worldMapRoomId !== undefined
    || session.pendingDuelSettlementNotice !== undefined
    || session.phase === 'world'
    || session.phase === 'combat'
  );
}

export function replaceSessionForReconnect(
  existingSession: ClientSession,
  replacementSessionId: string,
): void {
  if (existingSession.socket.destroyed || existingSession.replacedBySessionId !== undefined) {
    return;
  }

  if (shouldPreserveWorldResume(existingSession)) {
    worldResumeRegistry.save(existingSession);
    existingSession.skipWorldResumeSave = true;
  }

  existingSession.replacedBySessionId = replacementSessionId;
  existingSession.socket.destroy();
}
