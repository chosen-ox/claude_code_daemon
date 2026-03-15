// ID generation utilities

import { v4 as uuidv4 } from 'uuid';

export function generateTaskId(): string {
  const uuid = uuidv4();
  return `task-${uuid.substring(0, 8)}`;
}

export function generateSessionId(): string {
  return uuidv4();
}
