import { ulid } from "ulid";

export function newMemoryId(): string {
  return ulid();
}

export function newEventId(): string {
  return ulid();
}
